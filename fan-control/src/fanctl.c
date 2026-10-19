/*
 * fanctl - temperature-driven fan control for Apple Silicon / Intel Macs.
 *
 * Design goals:
 *   - Negligible steady-state cost: one long-lived AppleSMC connection, key
 *     metadata cached at startup, a handful of reads per poll, and a write
 *     only when the chosen step actually changes.
 *   - Stepped curve with hysteresis + dwell, so the fan settles instead of
 *     tracking every temperature wiggle.
 *   - Fail safe: on exit, crash-restart, or unreadable sensors, hand control
 *     back to the SMC's own algorithm.
 */

#include "smc.h"

#include <errno.h>
#include <math.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define VERSION "1.5.0-archipel.2"
#define DEFAULT_CONF "/Library/MiniArchipel/FanControl/fanctl.conf"
#define RUN_DIR      "/Library/MiniArchipel/FanControl"
#define PAUSE_FILE   RUN_DIR "/fanctl.paused"
#define RUNTIME_FILE RUN_DIR "/fanctl.runtime.json"

/* Seconds between writes while the fan command is ramping. */
#define RAMP_TICK    0.5

#define MAX_FANS    8
#define MAX_STEPS   16
#define MAX_SENSORS 64

/* ---------------------------------------------------------------- config */

enum { MODE_FLOOR = 0, MODE_FORCE = 1, MODE_AUTO = 2 };
enum { AGG_MEAN = 0, AGG_MAX = 1 };

typedef struct { double temp; double rpm; } step_t;

typedef struct {
    double poll;            /* seconds between samples                      */
    double alpha_up;        /* EWMA weight when temperature is rising        */
    double alpha_down;      /* EWMA weight when temperature is falling       */
    double hysteresis;      /* degC of slack before stepping down            */
    double down_delay;      /* seconds a step-down must stay justified       */
    double up_delay;        /* seconds a step-up must stay justified         */
    double slew_up;         /* max rpm/sec the command may rise            */
    double slew_down;       /* max rpm/sec the command may fall            */
    double min_rpm;         /* hardware floor, also the restore value        */
    double max_rpm;         /* hardware ceiling                              */
    double critical_temp;   /* at or above this: jump straight to max_rpm    */
    int    mode;            /* MODE_FLOOR (safe) or MODE_FORCE (exact)       */
    int    aggregate;       /* AGG_MEAN (per-family mean) or AGG_MAX          */
    int    nsteps;
    step_t steps[MAX_STEPS];
    char   sensors[1024];   /* "auto" or comma-separated SMC keys           */
    char   fans[64];        /* "all" or comma-separated fan indices         */
} cfg_t;

static void cfg_defaults(cfg_t *c) {
    memset(c, 0, sizeof(*c));
    c->poll          = 3.0;
    /* Apple Silicon core-die sensors spike 20C+ for a few hundred ms on any
     * momentary burst, so the raw signal is useless as a control input. Bulk
     * die/heatsink temperature - what the fan can actually affect - moves on a
     * tens-of-seconds timescale, so we smooth to roughly a 10s rise / 40s fall
     * time constant at the default 3s poll. Measured headroom on an M4 mini:
     * idle spikes push the control value to ~58C, which at alpha 0.30 lifts the
     * average to ~53C - still clear of the first curve threshold at 58C. */
    c->alpha_up      = 0.30;
    c->alpha_down    = 0.08;
    c->hysteresis    = 5.0;
    c->down_delay    = 30.0;
    /* A momentary burst clears several curve thresholds at once, so a
     * step-up has to prove it is real before the fan reacts. Costs a few
     * seconds of response against a thermal mass that moves in tens. */
    c->up_delay      = 8.0;
    /* Rate limit on the commanded RPM. What gets noticed is the fan
     * accelerating, not the speed it settles at: writing a 2200 rpm jump
     * straight to F0Tg makes it slam, while the same change spread over
     * ~10s is a swell you do not look up from. */
    c->slew_up       = 200.0;
    c->slew_down     = 120.0;
    c->min_rpm       = 1000;
    c->max_rpm       = 4900;
    c->critical_temp = 98.0;
    c->mode          = MODE_AUTO;
    c->aggregate     = AGG_MEAN;
    snprintf(c->sensors, sizeof(c->sensors), "auto");
    snprintf(c->fans, sizeof(c->fans), "all");

    static const step_t d[] = {
        {  0, 1000 }, { 58, 1400 }, { 65, 1800 }, { 71, 2300 },
        { 77, 2900 }, { 83, 3600 }, { 89, 4300 }, { 95, 4900 },
    };
    c->nsteps = (int)(sizeof(d) / sizeof(d[0]));
    memcpy(c->steps, d, sizeof(d));
}

/* --------------------------------------------------------------- logging */

static bool g_dry = false;   /* -n: decide and log, but never write */
static bool g_json = false;  /* -j: machine-readable status, for the UI */
/* Progress that redraws itself is only progress on a terminal. Redirected,
 * carriage returns pile every sample onto one unreadable line. */
static bool g_tty = false;
static bool g_verbose = false; /* -v: log every poll, for tuning the curve */

static void logf_(const char *fmt, ...) {
    char ts[32];
    time_t t = time(NULL);
    struct tm tm;
    localtime_r(&t, &tm);
    strftime(ts, sizeof(ts), "%Y-%m-%d %H:%M:%S", &tm);

    va_list ap;
    va_start(ap, fmt);
    fprintf(stderr, "%s ", ts);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    va_end(ap);
    fflush(stderr);
}

static double now_mono(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

static void sleep_sec(double s) {
    struct timespec ts = { (time_t)s, (long)((s - (double)(time_t)s) * 1e9) };
    nanosleep(&ts, NULL);
}

/* ------------------------------------------------------------ fan/SMC IO */

typedef struct {
    uint32_t key;
    uint32_t size;
    uint32_t type;
    char     name[5];
} skey_t;

static bool skey_init(skey_t *k, const char *name) {
    uint32_t key = smc_key(name);
    if (smc_key_info(key, &k->size, &k->type) != 0) return false;
    if (k->size == 0 || k->size > SMC_DATA_MAX) return false;
    k->key = key;
    memcpy(k->name, name, 4);
    k->name[4] = 0;
    return true;
}

static bool skey_read(const skey_t *k, double *v) {
    return smc_read_num(k->key, k->size, k->type, v) == 0;
}

static bool skey_write(const skey_t *k, double v) {
    return smc_write_num(k->key, k->size, k->type, v) == 0;
}

/* The SMC applies writes asynchronously - reading a key back immediately after
 * writing it still returns the old value, for up to a second or so. Poll until
 * the new value shows up rather than trusting the write call alone. */
static bool skey_write_confirm(const skey_t *k, double v, double timeout) {
    if (!skey_write(k, v)) return false;
    for (double t = 0; t < timeout; t += 0.05) {
        double back;
        if (skey_read(k, &back) && fabs(back - v) < 1.0) return true;
        sleep_sec(0.05);
    }
    return false;
}

/* F0Mn is read-only on some machines (an M4 mini refuses it with 0x86). Probe
 * by writing back the value it already holds, which is a no-op where it works.
 *
 * Anything other than a clean success counts as not writable. Treating only
 * 0x86 as a refusal looked tidier but reported every key as writable when run
 * without root, where the call never reaches the SMC and there is no result
 * byte to inspect at all. */
static bool skey_writable(const skey_t *k) {
    double cur;
    if (!skey_read(k, &cur)) return false;
    return skey_write(k, cur);
}

typedef struct {
    int    idx;      /* the N in F<N>Ac         */
    skey_t actual;   /* F<N>Ac - measured RPM   */
    skey_t target;   /* F<N>Tg - requested RPM  */
    skey_t mode;     /* F<N>Md - 0 auto, 1 forced */
    skey_t fmin;     /* F<N>Mn - minimum RPM    */
    skey_t fmax;     /* F<N>Mx - maximum RPM    */
    bool   has_mode, has_fmin;
    double hw_max;   /* F<N>Mx as read at startup, 0 if implausible */
} fan_t;

static bool fan_init(fan_t *f, int idx) {
    char k[5];
    memset(f, 0, sizeof(*f));
    f->idx = idx;
    snprintf(k, sizeof k, "F%dAc", idx); if (!skey_init(&f->actual, k)) return false;
    snprintf(k, sizeof k, "F%dTg", idx); if (!skey_init(&f->target, k)) return false;
    snprintf(k, sizeof k, "F%dMx", idx); if (!skey_init(&f->fmax,   k)) return false;
    snprintf(k, sizeof k, "F%dMd", idx); f->has_mode = skey_init(&f->mode, k);
    if (!f->has_mode) {
        snprintf(k, sizeof k, "F%dmd", idx); /* M6 uses lowercase md. */
        f->has_mode = skey_init(&f->mode, k);
    }
    snprintf(k, sizeof k, "F%dMn", idx); f->has_fmin = skey_init(&f->fmin, k);
    if (!skey_read(&f->fmax, &f->hw_max) || f->hw_max < 100 || f->hw_max > 20000)
        f->hw_max = 0;
    return true;
}

/* Every fan the machine has, or the subset the config asked for. Machines with
 * two fans (14"/16" MacBook Pro, some iMacs) were previously left with only
 * fan 0 managed and the rest on the SMC's own thermostat. */
typedef struct {
    fan_t f[MAX_FANS];
    int   n;
} fanset_t;

static unsigned fans_mask(const char *want) {
    if (!*want || strcmp(want, "all") == 0) return ~0u;
    unsigned m = 0;
    char buf[64];
    snprintf(buf, sizeof buf, "%s", want);
    for (char *tok = strtok(buf, ", \t"); tok; tok = strtok(NULL, ", \t")) {
        int i = atoi(tok);
        if (i >= 0 && i < MAX_FANS) m |= 1u << i;
    }
    return m ? m : ~0u;
}

/* FNum is the SMC's own fan count. Where it is missing we probe instead and let
 * fan_init reject the indices that do not exist. */
static bool fanset_init(fanset_t *fs, const char *want) {
    skey_t nk;
    double nv = 0;
    int count = MAX_FANS;
    unsigned mask = fans_mask(want);

    fs->n = 0;
    if (skey_init(&nk, "FNum") && skey_read(&nk, &nv) && nv >= 1 && nv <= MAX_FANS)
        count = (int)nv;

    for (int i = 0; i < count && fs->n < MAX_FANS; i++) {
        if (!(mask & (1u << i))) continue;
        fan_t f;
        if (fan_init(&f, i)) fs->f[fs->n++] = f;
    }
    return fs->n > 0;
}

/* ------------------------------------------------------------- sensor set */

static skey_t g_sensors[MAX_SENSORS];
static int    g_nsensors = 0;
static bool   g_sensor_setup_ok = true;

static bool sensor_plausible(double v) { return v > 5.0 && v < 125.0; }

static void sensor_add(const char *name) {
    if (g_nsensors >= MAX_SENSORS) { g_sensor_setup_ok = false; return; }
    for (int i = 0; i < g_nsensors; i++)
        if (memcmp(g_sensors[i].name, name, 4) == 0) return;
    skey_t k;
    if (!skey_init(&k, name)) { g_sensor_setup_ok = false; return; }
    double v;
    if (!skey_read(&k, &v) || !sensor_plausible(v)) { g_sensor_setup_ok = false; return; }
    g_sensors[g_nsensors++] = k;
}

/* Probe one naming family and keep its `keep` hottest members. Grouping by
 * family (rather than taking a global top-N) guarantees the GPU dies stay in
 * the set even though they read cool while the machine is idle. */
static void probe_family(const char *prefix, const char *mids, int keep) {
    static const char sfx[] = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
                              "abcdefghijklmnopqrstuvwxyz";
    skey_t best[16];
    double bestv[16];
    int n = 0;
    if (keep > 16) keep = 16;

    for (const char *m = mids; *m; m++) {
        for (const char *s = sfx; *s; s++) {
            char name[5] = { prefix[0], prefix[1], *m, *s, 0 };
            skey_t k;
            double v;
            if (!skey_init(&k, name)) continue;
            if (!skey_read(&k, &v) || !sensor_plausible(v)) continue;

            int pos = n;
            if (n < keep) n++;
            else if (v <= bestv[keep - 1]) continue;
            else pos = keep - 1;
            while (pos > 0 && bestv[pos - 1] < v) {
                best[pos] = best[pos - 1];
                bestv[pos] = bestv[pos - 1];
                pos--;
            }
            best[pos] = k;
            bestv[pos] = v;
        }
    }
    for (int i = 0; i < n && g_nsensors < MAX_SENSORS; i++)
        g_sensors[g_nsensors++] = best[i];
}

static void sensors_auto(void) {
    probe_family("Tp", "0123", 10);   /* Apple Silicon CPU core clusters */
    probe_family("Tg", "01",    6);   /* Apple Silicon GPU dies          */
    probe_family("Tm", "0123", 4);    /* memory - how many varies by config */
    /* Deliberately not TCMz: it is the die maximum, i.e. exactly max(Tp**),
     * so as a one-member family it would win every cross-family max and
     * cancel out the averaging AGG_MEAN exists to do. */
    /* Intel fallbacks - no-ops on Apple Silicon. */
    sensor_add("TC0P"); sensor_add("TC0E"); sensor_add("TC0F");
    sensor_add("TCXC"); sensor_add("TG0P"); sensor_add("TG0D");
}

static void sensors_setup(const cfg_t *cfg) {
    g_nsensors = 0;
    g_sensor_setup_ok = true;
    if (strcmp(cfg->sensors, "auto") == 0) {
        sensors_auto();
    } else {
        char buf[sizeof(cfg->sensors)];
        snprintf(buf, sizeof(buf), "%s", cfg->sensors);
        for (char *tok = strtok(buf, ", \t"); tok; tok = strtok(NULL, ", \t")) {
            if (strlen(tok) == 4) sensor_add(tok);
            else logf_("warn: ignoring bad sensor key '%s'", tok);
        }
    }
}

/* Control input and peak, in one pass over the sensor set.
 *
 * `ctrl` drives the curve. In AGG_MEAN it is the hottest *family* average -
 * mean over the Tp** dies, mean over the Tg** dies, and so on, then the max of
 * those. Averaging inside a family tracks the bulk temperature of that die
 * region; taking the max across families lets whichever subsystem is actually
 * hot own the fan. AGG_MAX skips the averaging and uses the single hottest
 * sensor, which reacts sooner but jitters much more.
 *
 * `peak` is always the raw hottest reading, and only feeds the critical-
 * temperature cutout - that one should not be smoothed or averaged away.
 *
 * Missing/invalid configured sensors invalidate the entire sample. */
static bool sensors_sample(int aggregate, double *ctrl, double *peak,
                           const char **who) {
    if (!g_sensor_setup_ok) return false;
    struct { uint32_t fam; double sum; int n; } g[8];
    int ng = 0;
    double mx = -1e9;
    const char *hot = NULL;

    for (int i = 0; i < g_nsensors; i++) {
        double v;
        if (!skey_read(&g_sensors[i], &v) || !sensor_plausible(v)) return false;
        if (v > mx) { mx = v; hot = g_sensors[i].name; }

        uint32_t fam = g_sensors[i].key >> 16;   /* first two chars */
        int j = 0;
        while (j < ng && g[j].fam != fam) j++;
        if (j == ng) {
            if (ng == 8) continue;
            g[ng].fam = fam; g[ng].sum = 0; g[ng].n = 0; ng++;
        }
        g[j].sum += v;
        g[j].n++;
    }
    if (!hot) return false;

    double c = mx;
    if (aggregate == AGG_MEAN) {
        c = -1e9;
        for (int j = 0; j < ng; j++) {
            double avg = g[j].sum / g[j].n;
            if (avg > c) c = avg;
        }
    }
    *ctrl = c;
    *peak = mx;
    if (who) *who = hot;
    return true;
}

/* ------------------------------------------------------------ conf parser */

static char *trim(char *s) {
    while (*s == ' ' || *s == '\t') s++;
    char *e = s + strlen(s);
    while (e > s && (e[-1] == ' ' || e[-1] == '\t' || e[-1] == '\r' || e[-1] == '\n'))
        *--e = 0;
    return s;
}

static bool parse_curve(cfg_t *c, char *val) {
    step_t tmp[MAX_STEPS];
    int n = 0;
    for (char *tok = strtok(val, ","); tok; tok = strtok(NULL, ",")) {
        double t, r;
        if (sscanf(tok, " %lf : %lf", &t, &r) != 2) return false;
        if (n >= MAX_STEPS) return false;
        tmp[n].temp = t;
        tmp[n].rpm = r;
        n++;
    }
    if (n < 1) return false;
    for (int i = 1; i < n; i++)
        if (tmp[i].temp <= tmp[i - 1].temp || tmp[i].rpm < tmp[i - 1].rpm)
            return false;   /* must be ascending in both */
    tmp[0].temp = 0;         /* the base step always applies */
    c->nsteps = n;
    memcpy(c->steps, tmp, sizeof(step_t) * (size_t)n);
    return true;
}

static bool cfg_load(cfg_t *c, const char *path, bool quiet) {
    FILE *fp = fopen(path, "r");
    if (!fp) {
        if (!quiet && errno != ENOENT)
            logf_("warn: cannot read %s: %s", path, strerror(errno));
        return false;
    }
    char line[1200];
    int lineno = 0;
    while (fgets(line, sizeof(line), fp)) {
        lineno++;
        char *s = trim(line);
        if (!*s || *s == '#' || *s == ';') continue;
        char *eq = strchr(s, '=');
        if (!eq) { logf_("warn: %s:%d: no '='", path, lineno); continue; }
        *eq = 0;
        char *k = trim(s), *v = trim(eq + 1);

        if      (!strcmp(k, "poll_interval"))  c->poll = atof(v);
        else if (!strcmp(k, "alpha_up"))       c->alpha_up = atof(v);
        else if (!strcmp(k, "alpha_down"))     c->alpha_down = atof(v);
        else if (!strcmp(k, "hysteresis"))     c->hysteresis = atof(v);
        else if (!strcmp(k, "down_delay"))     c->down_delay = atof(v);
        else if (!strcmp(k, "up_delay"))       c->up_delay = atof(v);
        else if (!strcmp(k, "slew_up"))        c->slew_up = atof(v);
        else if (!strcmp(k, "slew_down"))      c->slew_down = atof(v);
        else if (!strcmp(k, "min_rpm"))        c->min_rpm = atof(v);
        else if (!strcmp(k, "max_rpm"))        c->max_rpm = atof(v);
        else if (!strcmp(k, "critical_temp"))  c->critical_temp = atof(v);
        else if (!strcmp(k, "fans"))          snprintf(c->fans, sizeof(c->fans), "%s", v);
        else if (!strcmp(k, "sensors"))        snprintf(c->sensors, sizeof(c->sensors), "%s", v);
        else if (!strcmp(k, "mode"))
            c->mode = !strcmp(v, "force") ? MODE_FORCE :
                      !strcmp(v, "floor") ? MODE_FLOOR : MODE_AUTO;
        else if (!strcmp(k, "aggregate"))
            c->aggregate = !strcmp(v, "max") ? AGG_MAX : AGG_MEAN;
        else if (!strcmp(k, "curve")) {
            if (!parse_curve(c, v)) logf_("warn: %s:%d: bad curve, keeping previous", path, lineno);
        }
        else logf_("warn: %s:%d: unknown key '%s'", path, lineno, k);
    }
    fclose(fp);

    if (c->poll < 0.5) c->poll = 0.5;
    if (c->poll > 60)  c->poll = 60;
    if (c->alpha_up   <= 0 || c->alpha_up   > 1) c->alpha_up = 0.30;
    if (c->alpha_down <= 0 || c->alpha_down > 1) c->alpha_down = 0.08;
    if (c->hysteresis < 0) c->hysteresis = 0;
    /* 0 or negative would freeze the command; treat it as "no limit". */
    if (c->slew_up   <= 0) c->slew_up   = 1e9;
    if (c->slew_down <= 0) c->slew_down = 1e9;
    return true;
}

/* ------------------------------------------------------------- fan curve */

/* Step whose threshold the (smoothed) temperature has cleared. */
static int step_for(const cfg_t *c, double t, int cur) {
    int up = 0;
    for (int i = c->nsteps - 1; i > 0; i--)
        if (t >= c->steps[i].temp) { up = i; break; }
    if (up > cur) return up;            /* rising: react at the threshold   */

    int down = cur;                     /* falling: need hysteresis of slack */
    while (down > 0 && t < c->steps[down].temp - c->hysteresis) down--;
    return down;
}

static int policy_step(const cfg_t *c, double temp, double tick, double gap,
                       int level, double below_since[MAX_STEPS]) {
    int want = step_for(c, temp, level);
    for (int i = 1; i < c->nsteps; i++) {
        if (gap > c->poll * 3 || temp >= c->steps[i].temp - c->hysteresis)
            below_since[i] = -1;
        else if (below_since[i] < 0) below_since[i] = tick;
    }
    if (want > level) return want; /* This deployment specifies up_delay=0. */
    while (level > want && below_since[level] >= 0 &&
           tick - below_since[level] >= c->down_delay) level--;
    return level;
}

static double clampd(double v, double lo, double hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

/* ------------------------------------------------------------ apply state */

/* `mode = auto` picks whichever method this machine actually supports, so the
 * same config works on a Mac where F0Mn is writable and one where it is not. */
static int resolve_mode(const fan_t *f, int mode, bool verbose) {
    if (mode == MODE_FORCE || g_dry) return mode == MODE_AUTO ? MODE_FORCE : mode;
    bool floor_ok = f->has_fmin && skey_writable(&f->fmin);
    if (mode == MODE_AUTO) {
        if (verbose)
            logf_("mode auto -> %s (F%dMn is %s)", floor_ok ? "floor" : "force", f->idx,
                  !f->has_fmin ? "missing" : floor_ok ? "writable" : "read-only");
        return floor_ok ? MODE_FLOOR : MODE_FORCE;
    }
    if (mode == MODE_FLOOR && !floor_ok) {
        if (verbose)
            logf_("warn: F%dMn is %s here, falling back to force mode", f->idx,
                  f->has_fmin ? "read-only" : "missing");
        return MODE_FORCE;
    }
    return mode;
}

/* Two ways to drive the fan:
 *
 *   floor  raise F0Mn and leave the SMC's algorithm in charge above it. Safe,
 *          but F0Mn is read-only on some machines, so it is not always an option.
 *   force  F0Md=1 pins the fan at F0Tg. F0Tg is only an input while F0Md is 1;
 *          in auto mode it is the SMC's own output and writing it does nothing,
 *          so the mode flag has to land first.
 *
 * In force mode the base step deliberately hands control back (F0Md=0) instead
 * of pinning the fan at its minimum. At that step we want exactly what the SMC
 * would do anyway, and it means an unclean death leaves the machine on its own
 * thermostat rather than nailed to 1000 rpm while it heats up - which is the
 * exact failure this tool exists to fix. */
static bool fan_apply(const fan_t *f, const cfg_t *c, double rpm, bool *wrote) {
    bool ok = true;
    double cur;
    *wrote = false;

    if (c->mode == MODE_FLOOR && f->has_fmin) {
        if (f->has_mode && skey_read(&f->mode, &cur) && cur != 0)
            ok &= skey_write_confirm(&f->mode, 0, 2.0);
        if (!skey_read(&f->fmin, &cur) || fabs(cur - rpm) > 1.0) {
            ok &= skey_write_confirm(&f->fmin, rpm, 2.0);
            *wrote = true;
        }
        return ok;
    }

    if (!f->has_mode) return false;
    if (rpm <= c->min_rpm + 1) {
        if (f->has_mode && (!skey_read(&f->mode, &cur) || cur != 0)) {
            ok &= skey_write_confirm(&f->mode, 0, 2.0);
            *wrote = true;
        }
        return ok;
    }

    if (f->has_mode && (!skey_read(&f->mode, &cur) || cur != 1)) {
        if (!skey_write_confirm(&f->mode, 1, 2.0)) return false;
        *wrote = true;
    }
    if (!skey_read(&f->target, &cur) || fabs(cur - rpm) > 1.0) {
        ok &= skey_write_confirm(&f->target, rpm, 2.0);
        *wrote = true;
    }
    return ok;
}

/* One curve, applied to every managed fan, each clamped to its own ceiling:
 * a smaller fan must not be asked for RPM it cannot reach, and a larger one
 * should not be held back by a smaller sibling. */
static bool fanset_apply(const fanset_t *fs, const cfg_t *c, double rpm, bool *wrote) {
    bool ok = true;
    *wrote = false;
    for (int i = 0; i < fs->n; i++) {
        bool w = false;
        double r = rpm;
        if (fs->f[i].hw_max > 100) r = clampd(r, c->min_rpm, fs->f[i].hw_max);
        ok &= fan_apply(&fs->f[i], c, r, &w);
        *wrote |= w;
    }
    return ok;
}

static bool fan_release(const fan_t *f, const cfg_t *c) {
    bool ok = true;
    if (c->mode == MODE_FLOOR && f->has_fmin && skey_writable(&f->fmin))
        ok &= skey_write_confirm(&f->fmin, c->min_rpm, 2.0);
    if (!f->has_mode) return false;
    ok &= skey_write_confirm(&f->mode, 0, 2.0);
    return ok;
}

static bool fanset_release(const fanset_t *fs, const cfg_t *c) {
    bool ok = true;
    for (int i = 0; i < fs->n; i++) ok &= fan_release(&fs->f[i], c);
    return ok;
}

/* ----------------------------------------------------------------- daemon */

static volatile sig_atomic_t g_stop = 0;
static volatile sig_atomic_t g_reload = 0;

static void on_signal(int sig) {
    if (sig == SIGHUP) g_reload = 1; else g_stop = 1;
}

/* Published by the actual control loop, never inferred from a fresh CLI sample. */
static char g_config_identity[128] = "";
static void publish_runtime(const cfg_t *cfg, double ctrl, double raw, double peak,
                            int level, double commanded, double target, bool emergency,
                            bool paused, const double below_since[MAX_STEPS]) {
    if (g_dry) return;
    char temp[256];
    snprintf(temp, sizeof temp, RUNTIME_FILE ".%d.next", getpid());
    FILE *out = fopen(temp, "w");
    if (!out) return;
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    fprintf(out, "{\"pid\":%d,\"ts\":%lld,\"config_identity\":\"%s\",",
            getpid(), (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000, g_config_identity);
    fprintf(out, "\"control_temp\":");
    if (isfinite(ctrl) && ctrl >= 0) fprintf(out, "%.2f", ctrl); else fprintf(out, "null");
    fprintf(out, ",\"raw_temp\":%.2f,\"peak\":%.2f,\"level\":%d,"
            "\"command_rpm\":%.2f,\"target_rpm\":%.2f,\"emergency\":%s,\"paused\":%s,\"down_remaining\":[",
            raw, peak, level, commanded, target, emergency ? "true" : "false", paused ? "true" : "false");
    double tick = now_mono();
    for (int i = 1; i < cfg->nsteps; i++)
        fprintf(out, "%s%.1f", i > 1 ? "," : "", below_since[i] < 0 ? cfg->down_delay : fmax(0, cfg->down_delay - (tick - below_since[i])));
    fprintf(out, "]}\n");
    if (fclose(out) == 0) rename(temp, RUNTIME_FILE);
    unlink(temp);
}

static void describe_setup(const cfg_t *c) {
    char buf[MAX_SENSORS * 6 + 1] = {0};
    size_t off = 0;
    for (int i = 0; i < g_nsensors && off + 6 < sizeof(buf); i++)
        off += (size_t)snprintf(buf + off, sizeof(buf) - off, "%s%s",
                                i ? " " : "", g_sensors[i].name);
    logf_("mode=%s agg=%s poll=%.1fs hyst=%.1fC delay=%.0f/%.0fs "
          "slew=%.0f/%.0f rpm/s alpha=%.2f/%.2f steps=%d",
          c->mode == MODE_FORCE ? "force" : c->mode == MODE_FLOOR ? "floor" : "auto",
          c->aggregate == AGG_MAX ? "max" : "mean",
          c->poll, c->hysteresis, c->up_delay, c->down_delay,
          c->slew_up, c->slew_down,
          c->alpha_up, c->alpha_down, c->nsteps);
    logf_("sensors(%d): %s", g_nsensors, buf);
}

static int run_daemon(const char *conf) {
    cfg_t cfg;
    cfg_defaults(&cfg);
    if (!cfg_load(&cfg, conf, false)) {
        logf_("error: configuration is required"); return 1;
    }
    if (cfg.mode != MODE_FORCE || cfg.up_delay != 0 || strcmp(cfg.sensors, "auto") == 0) {
        logf_("error: this build requires force mode, immediate rise and explicit sensors"); return 1;
    }
    signal(SIGTERM, on_signal);
    signal(SIGINT, on_signal);
    signal(SIGHUP, on_signal);

    if (smc_open() != 0) { logf_("error: cannot open AppleSMC"); return 1; }

    fanset_t fans;
    if (!fanset_init(&fans, cfg.fans)) {
        logf_("error: no fan keys (F0Ac/F0Tg/F0Mx)");
        return 1;
    }
    /* One mode for the set. In practice sibling fans on a machine expose the
     * same writability, and resolving per fan would allow a split that the rest
     * of the loop has no way to represent. */
    cfg.mode = resolve_mode(&fans.f[0], cfg.mode, true);
    for (int i = 0; i < fans.n; i++) {
        if (!fans.f[i].has_mode) { logf_("error: no fan mode key"); smc_close(); return 1; }
    }
    if (!g_dry && !fanset_release(&fans, &cfg)) {
        logf_("error: cannot restore system control at startup"); smc_close(); return 1;
    }

    /* Ceiling is the most capable fan's; each is clamped to its own on write. */
    double hw_max = 0;
    for (int i = 0; i < fans.n; i++) hw_max = fmax(hw_max, fans.f[i].hw_max);
    if (hw_max > 100) cfg.max_rpm = fmin(cfg.max_rpm, hw_max);

    sensors_setup(&cfg);
    if (g_nsensors == 0 || !g_sensor_setup_ok) { logf_("error: configured sensors unavailable"); smc_close(); return 1; }

    logf_("fanctl %s starting (%d fan%s, max_rpm=%.0f)", VERSION,
          fans.n, fans.n == 1 ? "" : "s", cfg.max_rpm);
    describe_setup(&cfg);

    signal(SIGTERM, on_signal);
    signal(SIGINT,  on_signal);
    signal(SIGHUP,  on_signal);

    struct stat st = {0};
    time_t conf_mtime = (stat(conf, &st) == 0) ? st.st_mtime : 0;
    snprintf(g_config_identity, sizeof g_config_identity, "%llu:%lld:%ld:%lld",
             (unsigned long long)st.st_ino, (long long)st.st_mtimespec.tv_sec,
             st.st_mtimespec.tv_nsec, (long long)st.st_size);

    double ewma = -1, last_tick = now_mono();
    int    level = 0, pending_dir = 0, exit_code = 0;
    double below_since[MAX_STEPS];
    for (int i = 0; i < MAX_STEPS; i++) below_since[i] = -1;
    double applied = -1, rpm = -1;
    int    logged_level = -1;
    bool   was_paused = false;
    int    fail_streak = 0, ticks = 0, write_fails = 0;

    while (!g_stop) {
        double tick = now_mono();
        double gap = tick - last_tick;
        last_tick = tick;

        if (g_reload || (++ticks % 20 == 0 && stat(conf, &st) == 0 && st.st_mtime != conf_mtime)) {
            logf_("configuration changed; returning control before restart");
            exit_code = 1; break;
        }

        /* Paused: hand the fan back and idle until the flag clears. The
         * menu bar item toggles fan control through this instead of unloading
         * the daemon, so pausing and resuming need no privilege dance and no
         * launchd round trip. */
        bool paused = (stat(PAUSE_FILE, &st) == 0);
        if (paused != was_paused) {
            was_paused = paused;
            logf_("%s", paused ? "paused - fan returned to SMC control" : "resumed");
            if (paused && !g_dry) fanset_release(&fans, &cfg);
            applied = -1; rpm = -1; ewma = -1;
            level = 0; pending_dir = 0; logged_level = -1;
            for (int i = 0; i < MAX_STEPS; i++) below_since[i] = -1;
        }
        if (paused) {
            publish_runtime(&cfg, -1, 0, 0, level, 0, 0, false, true, below_since);
            sleep_sec(cfg.poll); continue;
        }

        double temp, peak;
        const char *hot = NULL;
        if (!sensors_sample(cfg.aggregate, &temp, &peak, &hot)) {
            if (++fail_streak == 3) {
                logf_("error: sensors unreadable, returning fan to SMC control");
                exit_code = 1; break;
            }
            for (int i = 0; i < MAX_STEPS; i++) below_since[i] = -1;
            sleep_sec(cfg.poll);
            continue;
        }
        fail_streak = 0;

        /* A long gap means the machine slept; don't trust the old average. */
        if (ewma < 0 || gap > 60) ewma = temp;
        else {
            double a = (temp > ewma) ? cfg.alpha_up : cfg.alpha_down;
            /* alpha is specified per poll_interval, but the loop ticks faster
             * while ramping the fan. Rescale to the gap actually elapsed so the
             * smoothing time constant stays what the config asked for. */
            if (gap > 0 && cfg.poll > 0 && fabs(gap - cfg.poll) > 1e-3)
                a = 1.0 - pow(1.0 - a, gap / cfg.poll);
            ewma += a * (temp - ewma);
        }

        level = policy_step(&cfg, ewma, tick, gap, level, below_since);
        pending_dir = step_for(&cfg, ewma, level) < level ? -1 : 0;

        double want_rpm = clampd(cfg.steps[level].rpm, cfg.min_rpm, cfg.max_rpm);
        bool emergency = (peak >= cfg.critical_temp);   /* raw, unsmoothed */
        if (emergency) want_rpm = cfg.max_rpm;

        /* The curve is a step function, and writing its jump straight to F0Tg
         * makes the fan accelerate as hard as it can. That acceleration is what
         * gets noticed - far more than the RPM it lands on - so the command is
         * ramped instead. Overheating bypasses the limit. */
        if (rpm < 0 || emergency) {
            rpm = want_rpm;
        } else if (rpm != want_rpm) {
            double lim = ((want_rpm > rpm) ? cfg.slew_up : cfg.slew_down) * gap;
            double d = want_rpm - rpm;
            rpm = (fabs(d) <= lim) ? want_rpm : rpm + (d > 0 ? lim : -lim);
        }

        bool wrote = false;
        if (!g_dry && !fanset_apply(&fans, &cfg, rpm, &wrote)) {
            logf_("error: SMC write failed [%d]", ++write_fails);
            if (write_fails >= 3) { exit_code = 1; break; }
        } else if (wrote || rpm != applied) {
            write_fails = 0;
            /* Log the ends of a ramp - the level change that started it and the
             * arrival - not each intermediate write. */
            if (level != logged_level || rpm == want_rpm) {
                logf_("%sstep %d -> %.0f rpm%s  (avg %.1fC, now %.1fC, peak %.1fC @%s)",
                      g_dry ? "[dry] " : "", level, rpm,
                      rpm == want_rpm ? "" : " (ramping)",
                      ewma, temp, peak, hot ? hot : "?");
                logged_level = level;
            }
            applied = rpm;
        }

        publish_runtime(&cfg, ewma, temp, peak, level, rpm, want_rpm, emergency, false, below_since);
        if (g_verbose)
            logf_("  avg=%.1f ctrl=%.1f peak=%.1f@%s level=%d rpm=%.0f%s%s",
                  ewma, temp, peak, hot ? hot : "?", level, rpm,
                  rpm != want_rpm ? " (ramping)" : "",
                  pending_dir > 0 ? " (up pending)" :
                  pending_dir < 0 ? " (down pending)" : "");

        /* A ramp is only as smooth as the interval between writes: at a 3s poll
         * a 200 rpm/s limit still lands as 600 rpm stairs, which is audible.
         * While the command is moving, tick fast enough that each write is a
         * small step; the EWMA above is rescaled so this does not disturb the
         * temperature smoothing. */
        sleep_sec(rpm != want_rpm ? fmin(cfg.poll, RAMP_TICK) : cfg.poll);
    }

    logf_("stopping, returning fan to SMC control");
    if (!g_dry && !fanset_release(&fans, &cfg)) {
        logf_("error: could not restore SMC control"); exit_code = 1;
    }
    if (!g_dry) unlink(RUNTIME_FILE);
    smc_close();
    return exit_code;
}

/* ----------------------------------------------------------- calibration */

/* What `calibrate` is for.
 *
 * The shipped curve is measured on one machine (an M4 mini). On anything else
 * its RPM numbers are a guess, and guessing is the thing this project tries not
 * to do. So: put the machine under load, hold the fan at a series of fixed
 * speeds, and record where the temperature actually settles at each one.
 *
 * That measurement is a decreasing function -- more RPM, lower equilibrium --
 * while a fan curve is increasing. The two therefore cross exactly once, and
 * that crossing is where the machine will really sit. Which means the useful
 * question is not "what should the curve look like" but "what RPM holds the
 * temperature I asked for", and the answer is read straight off the locus. */

#define CAL_LEVELS 5
#define CAL_SETTLE 75.0   /* seconds held at each speed                    */
#define CAL_TAIL   25.0   /* average over the last of those, once settled  */
#define CAL_DRY_SETTLE 6.0 /* -n: long enough to exercise the loop, no more */

typedef struct { double rpm, temp, peak; } cal_pt;

static volatile sig_atomic_t g_burn = 0;

static void *burn_thread(void *unused) {
    volatile double x = 1.0;
    while (g_burn) {
        for (int i = 0; i < 4096; i++) x = x * 1.0000001 + 1e-9;
        if (x > 1e6) x = 1.0;
    }
    return NULL;
}

/* Read off the measured locus: the RPM whose equilibrium temperature is `cap`.
 * Returns -1 if even the fastest measured speed could not hold it. */
static double rpm_for_cap(const cal_pt *p, int n, double cap) {
    if (cap >= p[0].temp) return p[0].rpm;        /* the floor already holds it */
    if (cap < p[n - 1].temp) return -1;           /* out of reach               */
    for (int i = 1; i < n; i++) {
        if (cap >= p[i].temp) {
            double span = p[i - 1].temp - p[i].temp;
            double f = span > 0.01 ? (p[i - 1].temp - cap) / span : 0;
            return p[i - 1].rpm + f * (p[i].rpm - p[i - 1].rpm);
        }
    }
    return p[n - 1].rpm;
}

static int cmd_calibrate(const char *conf, double cap) {
    /* -n exercises everything except the SMC: the load, the sampling, the
     * settle loop, the safety guard and the derivation. It needs no root
     * because it writes nothing, and it uses a short settle because a dry run
     * cannot measure anything real anyway -- the fan is not being controlled,
     * so the equilibrium it would wait for does not exist. Its purpose is to
     * check the path, not the machine. */
    if (!isfinite(cap) || cap < 40 || cap > 100) { fprintf(stderr, "invalid calibration cap\n"); return 2; }
    if (!g_dry && geteuid() != 0) {
        fprintf(stderr, "calibrate has to write to the SMC: sudo fanctl calibrate\n");
        return 1;
    }
    cfg_t cfg;
    cfg_defaults(&cfg);
    cfg_load(&cfg, conf, true);
    if (smc_open() != 0) { fprintf(stderr, "cannot open AppleSMC\n"); return 1; }

    fanset_t fans;
    if (!fanset_init(&fans, cfg.fans)) { fprintf(stderr, "no fan keys found\n"); return 1; }
    sensors_setup(&cfg);
    if (g_nsensors == 0) { fprintf(stderr, "no usable temperature sensors\n"); return 1; }
    cfg.mode = resolve_mode(&fans.f[0], cfg.mode, false);

    double hw_max = 0;
    for (int i = 0; i < fans.n; i++) hw_max = fmax(hw_max, fans.f[i].hw_max);
    if (hw_max > 100) cfg.max_rpm = fmin(cfg.max_rpm, hw_max);

    long ncpu = sysconf(_SC_NPROCESSORS_ONLN);
    if (ncpu < 1) ncpu = 4;
    double settle = g_dry ? CAL_DRY_SETTLE : CAL_SETTLE;

    if (g_dry) {
        printf("[dry] Path check only: no SMC writes, %.0fs per step, and the\n"
               "[dry] daemon is left running -- so the temperatures below are not\n"
               "[dry] equilibria and the suggested curve is not usable.\n\n", settle);
    }
    printf("Calibrating against a %ld-thread load, %d fan speeds, ~%.1f minutes.\n",
           ncpu, CAL_LEVELS, CAL_LEVELS * settle / 60.0);
    if (!g_dry) {
        printf("The fan will be loud and the machine will be hot and slow throughout.\n");
        printf("Ctrl-C is safe: the fan is handed back to macOS on the way out.\n");
    }
    printf("\n");

    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);

    /* The daemon rewrites the fan every poll and would undo each level within
     * three seconds, quietly corrupting every reading. Pause it for the
     * duration through the same flag the menu bar app uses, and leave it as it
     * was found. */
    struct stat pst;
    bool was_paused = g_dry || (stat(PAUSE_FILE, &pst) == 0);
    if (!was_paused) {
        mkdir(RUN_DIR, 0755);
        FILE *pf = fopen(PAUSE_FILE, "w");
        if (pf) fclose(pf);
        printf("Pausing the daemon for the duration.\n");
        sleep_sec(4.0);   /* let it notice and let go of the fan */
    }
    #define CAL_DONE() do { if (!was_paused) unlink(PAUSE_FILE); } while (0)

    pthread_t th[256];
    long nth = ncpu > 256 ? 256 : ncpu;
    g_burn = 1;
    for (long i = 0; i < nth; i++) pthread_create(&th[i], NULL, burn_thread, NULL);

    cal_pt pts[CAL_LEVELS];
    int npts = 0;
    bool aborted = false;

    for (int L = 0; L < CAL_LEVELS && !g_stop; L++) {
        double rpm = cfg.min_rpm
                   + (cfg.max_rpm - cfg.min_rpm) * L / (double)(CAL_LEVELS - 1);
        bool wrote = false;
        if (!g_dry && !fanset_apply(&fans, &cfg, rpm, &wrote)) { aborted = true; break; }

        double t0 = now_mono(), sum = 0, peak_seen = 0;
        int nsum = 0;
        while (now_mono() - t0 < settle && !g_stop) {
            double temp, peak;
            const char *hot = NULL;
            double el = now_mono() - t0;
            if (sensors_sample(cfg.aggregate, &temp, &peak, &hot)) {
                if (g_json) {
                    printf("{\"type\":\"progress\",\"phase\":\"calibrating\",\"step\":%d,\"total\":%d,\"rpm\":%.0f,\"temp\":%.1f,\"peak\":%.1f}\n",
                           L + 1, CAL_LEVELS, rpm, temp, peak);
                    fflush(stdout);
                }
                if (peak > peak_seen) peak_seen = peak;
                if (el >= settle - fmin(CAL_TAIL, settle / 2)) { sum += temp; nsum++; }
                /* Judged on the raw peak, like the daemon's own safety net. */
                if (peak >= cfg.critical_temp) {
                    printf("%s  %5.0f rpm  aborting: peak hit %.1f C (critical_temp)\n",
                           g_tty ? "\r" : "", rpm, peak);
                    aborted = true;
                    break;
                }
                if (g_tty) {
                    printf("\r  %s%5.0f rpm  t+%3.0fs  %.1f C (peak %.1f)   ",
                           g_dry ? "[dry] " : "", rpm, el, temp, peak);
                    fflush(stdout);
                }
            } else { aborted = true; break; }
            sleep_sec(2.0);
        }
        if (aborted) break;
        if (nsum > 0) {
            pts[npts].rpm = rpm;
            pts[npts].temp = sum / nsum;
            pts[npts].peak = peak_seen;
            printf("%s  %s%5.0f rpm  %s %.1f C (peak %.1f)          \n",
                   g_tty ? "\r" : "",
                   g_dry ? "[dry] " : "", rpm,
                   g_dry ? "sampled  " : "settled at", pts[npts].temp, peak_seen);
            npts++;
        }
    }

    g_burn = 0;
    for (long i = 0; i < nth; i++) pthread_join(th[i], NULL);
    if (!g_dry) fanset_release(&fans, &cfg);

    if (g_stop || aborted || npts < 2) {
        printf("\nStopped early - not enough data to suggest a curve.\n");
        printf("The fan is back on macOS automatic control.\n");
        CAL_DONE();
        smc_close();
        return 1;
    }

    printf(g_dry ? "\n[dry] Sampled under load (not equilibria):\n"
                 : "\nEquilibrium under full load:\n");
    for (int i = 0; i < npts; i++)
        printf("  %5.0f rpm  ->  %.1f C\n", pts[i].rpm, pts[i].temp);

    if (g_dry) {
        if (g_json) printf("{\"type\":\"calibration\",\"dry_run\":true,\"valid\":false,\"curve\":null}\n");
        printf("[dry] Path checked under CPU load. No measured curve was produced.\n");
        CAL_DONE(); smc_close(); return 0;
    }

    /* The locus has to fall for any of this to mean anything: the method rests
     * entirely on "more RPM, lower equilibrium". A run where it does not fall is
     * not a curve waiting to be derived, it is a measurement to be thrown away.
     * Saying so beats the flat nonsense the interpolation would otherwise
     * produce and present as an answer. */
    double drop = pts[0].temp - pts[npts - 1].temp;
    if (drop < 3.0) {
        printf("\nThe temperature did not fall as the fan sped up"
               " (%.1f C across %.0f-%.0f rpm).\n", drop, pts[0].rpm, pts[npts - 1].rpm);
        printf("That is not a usable measurement. Likely causes:\n");
        if (g_dry)
            printf("  - this is a dry run, so the fan was never actually controlled\n");
        printf("  - something else was loading the machine, so the fan was not"
               " the only variable\n");
        printf("  - the settle time was too short for this machine's thermal mass\n");
        printf("  - the fan genuinely has little authority over this sensor\n");
        CAL_DONE();
        smc_close();
        return 1;
    }

    /* Small inversions are sampling noise, not physics. A running minimum keeps
     * the locus non-increasing so the interpolation cannot walk backwards. */
    for (int i = 1; i < npts; i++)
        if (pts[i].temp > pts[i - 1].temp) pts[i].temp = pts[i - 1].temp;

    printf("\nRPM needed to hold a given temperature:\n");
    for (double t = 95; t >= 60; t -= 5) {
        double r = rpm_for_cap(pts, npts, t);
        if (r < 0)  printf("  %2.0f C   out of reach on this machine\n", t);
        else        printf("  %2.0f C   %.0f rpm\n", t, r);
    }

    double rcap = rpm_for_cap(pts, npts, cap);
    if (rcap < 0) {
        printf("\nA %.0f C cap is not reachable even at %.0f rpm.\n", cap, cfg.max_rpm);
        printf("Pick a higher cap: fanctl calibrate %.0f\n", ceil(pts[npts - 1].temp));
        CAL_DONE();
        smc_close();
        return 1;
    }

    /* Ramp to the required RPM over the 15 C approaching the cap, then leave a
     * step above it at maximum so an unexpected load still has somewhere to go. */
    const double span = 15.0;
    printf("\nSuggested curve for a %.0f C cap (needs %.0f rpm):\n\n", cap, rcap);
    printf("curve = 0:%.0f", cfg.min_rpm);
    for (int i = 1; i <= 4; i++) {
        double t = cap - span + span * i / 4.0;
        double r = cfg.min_rpm + (rcap - cfg.min_rpm) * i / 4.0;
        printf(", %.0f:%.0f", t, round(r / 50) * 50);
    }
    printf(", %.0f:%.0f\n", cap + 5, cfg.max_rpm);

    if (g_json) {
        printf("{\"type\":\"calibration\",\"dry_run\":false,\"valid\":true,\"samples\":[");
        for (int k = 0; k < npts; k++) printf("%s{\"rpm\":%.0f,\"temp\":%.1f,\"peak\":%.1f}", k ? "," : "", pts[k].rpm, pts[k].temp, pts[k].peak);
        printf("],\"curve\":[{\"t\":0,\"rpm\":%.0f}", cfg.min_rpm);
        for (int k = 1; k <= 4; k++) printf(",{\"t\":%.0f,\"rpm\":%.0f}", cap - span + span * k / 4.0, round((cfg.min_rpm + (rcap - cfg.min_rpm) * k / 4.0) / 50) * 50);
        printf(",{\"t\":%.0f,\"rpm\":%.0f}]}\n", cap + 5, cfg.max_rpm);
    }

    if (g_dry) {
        printf("\n[dry] Path check finished. Nothing was written and the numbers\n");
        printf("[dry] above are not usable -- run without -n for a real one.\n");
    } else {
        printf("\nMeasured with a synthetic all-core load, which is a worst case:\n");
        printf("real work will usually sit below this. Paste the line into %s\n", conf);
        printf("(or edit the curve in the menu bar app) and the daemon reloads itself.\n");
        printf("The fan is back on macOS automatic control.\n");
    }
    CAL_DONE();
    smc_close();
    return 0;
}
#undef CAL_DONE

/* ------------------------------------------------------------- one-shots */

/* Control is suspended through a flag file rather than by stopping the daemon:
 * launchd would immediately restart it under KeepAlive, and resuming would then
 * need privilege at exactly the moment the fan is unmanaged. The daemon polls
 * the flag and releases the fan to the SMC while it is set. */
static int cmd_pause(bool on) {
    if (g_dry) { printf("[dry] pause state unchanged\n"); return 0; }
    if (on) {
        mkdir(RUN_DIR, 0755);
        FILE *f = fopen(PAUSE_FILE, "w");
        if (!f) {
            fprintf(stderr, "cannot create %s: %s\n", PAUSE_FILE, strerror(errno));
            return 1;
        }
        fclose(f);
        printf("paused - the daemon hands the fan back within one poll\n");
    } else {
        if (unlink(PAUSE_FILE) != 0 && errno != ENOENT) {
            fprintf(stderr, "cannot remove %s: %s\n", PAUSE_FILE, strerror(errno));
            return 1;
        }
        printf("resumed\n");
    }
    return 0;
}


static int cmd_status(const char *conf) {
    cfg_t cfg;
    cfg_defaults(&cfg);
    cfg_load(&cfg, conf, true);
    if (smc_open() != 0) { fprintf(stderr, "cannot open AppleSMC\n"); return 1; }

    fanset_t fans;
    if (!fanset_init(&fans, cfg.fans)) { fprintf(stderr, "no fan keys found\n"); return 1; }
    sensors_setup(&cfg);
    cfg.mode = resolve_mode(&fans.f[0], cfg.mode, false);

    double temp = 0, peak = 0, ac = 0, tg = 0, md = 0, mn = 0, mx = 0;
    const char *hot = NULL;
    bool have_t = sensors_sample(cfg.aggregate, &temp, &peak, &hot);
    /* Fan 0 drives the headline figures; the rest are listed only when they
     * exist, so a single-fan machine sees exactly what it always did. */
    const fan_t *f0 = &fans.f[0];
    skey_read(&f0->actual, &ac);
    skey_read(&f0->target, &tg);
    skey_read(&f0->fmax, &mx);
    if (f0->has_fmin) skey_read(&f0->fmin, &mn);
    if (f0->has_mode) skey_read(&f0->mode, &md);

    if (have_t) {
        printf("temp      %.1f C control (%s of %d sensors), %.1f C peak @%s\n",
               temp, cfg.aggregate == AGG_MAX ? "max" : "family mean",
               g_nsensors, peak, hot ? hot : "-");
    } else {
        printf("temp      n/a  (%d sensors, all unreadable)\n", g_nsensors);
    }
    if (fans.n == 1) {
        printf("fan       %.0f rpm actual, %.0f rpm target\n", ac, tg);
        printf("limits    min %.0f / max %.0f rpm\n", mn, mx);
    } else {
        printf("fans      %d managed\n", fans.n);
        for (int i = 0; i < fans.n; i++) {
            double a = 0, t = 0;
            skey_read(&fans.f[i].actual, &a);
            skey_read(&fans.f[i].target, &t);
            printf("  F%d      %.0f rpm actual, %.0f rpm target, max %.0f\n",
                   fans.f[i].idx, a, t, fans.f[i].hw_max);
        }
        printf("limits    min %.0f rpm\n", mn);
    }
    printf("smc mode  %s\n", md != 0
           ? "forced (F0Md=1) - fan pinned at target"
           : "auto (F0Md=0) - SMC's own thermostat");
    printf("fanctl    %s mode%s\n",
           cfg.mode == MODE_FORCE ? "force" : "floor",
           (cfg.mode == MODE_FORCE && md == 0)
               ? ", base step - control handed back to the SMC" : "");

    /* Mark the step the fan is actually on, not the one this instant's
     * temperature would pick. The daemon decides from a smoothed average, so
     * recomputing here from a single raw sample disagrees with reality often
     * enough to look like a bug. When we have handed control back (F0Md=0) the
     * fan is on the base step by definition. */
    int lvl = 0;
    if (md != 0) {
        double best = 1e9;
        for (int i = 0; i < cfg.nsteps; i++) {
            double d = fabs(cfg.steps[i].rpm - tg);
            if (d < best) { best = d; lvl = i; }
        }
    }
    printf("curve     ");
    for (int i = 0; i < cfg.nsteps; i++)
        printf("%s%.0fC:%.0f%s", i ? " " : "",
               cfg.steps[i].temp, cfg.steps[i].rpm, i == lvl ? "*" : "");
    printf("   (* = where the fan is now)\n");
    smc_close();
    return 0;
}

/* Same reading as cmd_status, emitted for the menu bar app. Kept in this file
 * so the two can never disagree about what "the level the fan is on" means. */
static int status_json(const char *conf) {
    cfg_t cfg;
    cfg_defaults(&cfg);
    cfg_load(&cfg, conf, true);
    if (smc_open() != 0) {
        printf("{\"ok\":false,\"error\":\"cannot open AppleSMC\"}\n");
        return 1;
    }
    fanset_t fans;
    if (!fanset_init(&fans, cfg.fans)) {
        printf("{\"ok\":false,\"error\":\"no fan keys found\"}\n");
        return 1;
    }
    sensors_setup(&cfg);
    cfg.mode = resolve_mode(&fans.f[0], cfg.mode, false);

    double temp = 0, peak = 0, ac = 0, tg = 0, md = 0, mn = 0, mx = 0;
    const char *hot = NULL;
    bool have_t = sensors_sample(cfg.aggregate, &temp, &peak, &hot);
    /* Fan 0 drives the headline figures; the rest are listed only when they
     * exist, so a single-fan machine sees exactly what it always did. */
    const fan_t *f0 = &fans.f[0];
    skey_read(&f0->actual, &ac);
    skey_read(&f0->target, &tg);
    skey_read(&f0->fmax, &mx);
    if (f0->has_fmin) skey_read(&f0->fmin, &mn);
    if (f0->has_mode) skey_read(&f0->mode, &md);

    int lvl = 0;
    if (md != 0) {
        double best = 1e9;
        for (int i = 0; i < cfg.nsteps; i++) {
            double d = fabs(cfg.steps[i].rpm - tg);
            if (d < best) { best = d; lvl = i; }
        }
    }
    struct stat pst;
    bool paused = (stat(PAUSE_FILE, &pst) == 0);

    printf("{\"ok\":true");
    printf(",\"have_temp\":%s", have_t ? "true" : "false");
    printf(",\"temp\":%.1f,\"peak\":%.1f,\"peak_sensor\":\"%s\"",
           temp, peak, hot ? hot : "");
    printf(",\"nsensors\":%d", g_nsensors);
    printf(",\"rpm\":%.0f,\"target\":%.0f", ac, tg);
    printf(",\"nfans\":%d", fans.n);
    printf(",\"fans\":[");
    for (int i = 0; i < fans.n; i++) {
        double a = 0, t = 0;
        skey_read(&fans.f[i].actual, &a);
        skey_read(&fans.f[i].target, &t);
        printf("%s{\"idx\":%d,\"rpm\":%.0f,\"target\":%.0f,\"max\":%.0f}",
               i ? "," : "", fans.f[i].idx, a, t, fans.f[i].hw_max);
    }
    printf("]");
    printf(",\"min_rpm\":%.0f,\"max_rpm\":%.0f", mn, mx);
    printf(",\"forced\":%s", md != 0 ? "true" : "false");
    printf(",\"mode\":\"%s\"", cfg.mode == MODE_FORCE ? "force" : "floor");
    printf(",\"paused\":%s", paused ? "true" : "false");
    printf(",\"level\":%d", lvl);
    printf(",\"up_delay\":%.0f,\"down_delay\":%.0f", cfg.up_delay, cfg.down_delay);
    printf(",\"slew_up\":%.0f,\"slew_down\":%.0f", cfg.slew_up, cfg.slew_down);
    printf(",\"hysteresis\":%.1f,\"poll\":%.1f", cfg.hysteresis, cfg.poll);
    printf(",\"alpha_up\":%.2f,\"alpha_down\":%.2f", cfg.alpha_up, cfg.alpha_down);
    printf(",\"critical_temp\":%.0f", cfg.critical_temp);
    printf(",\"curve\":[");
    for (int i = 0; i < cfg.nsteps; i++)
        printf("%s{\"t\":%.0f,\"rpm\":%.0f}", i ? "," : "",
               cfg.steps[i].temp, cfg.steps[i].rpm);
    printf("]}\n");
    smc_close();
    return 0;
}

static int cmd_temps(const char *conf) {
    cfg_t cfg;
    cfg_defaults(&cfg);
    cfg_load(&cfg, conf, true);
    if (smc_open() != 0) { fprintf(stderr, "cannot open AppleSMC\n"); return 1; }
    sensors_setup(&cfg);
    if (g_json) printf("[");
    for (int i = 0; i < g_nsensors; i++) {
        double v = 0;
        bool ok = skey_read(&g_sensors[i], &v) && sensor_plausible(v);
        if (g_json) {
            printf("%s{\"key\":\"%s\",\"temp\":", i ? "," : "", g_sensors[i].name);
            if (ok) printf("%.1f", v); else printf("null");
            printf("}");
        } else if (ok) printf("%-5s %6.1f C\n", g_sensors[i].name, v);
    }
    if (g_json) printf("]\n");
    smc_close();
    return 0;
}

static int cmd_set(double rpm, int mode) {
    if (!isfinite(rpm) || rpm < 1000 || rpm > 20000) {
        fprintf(stderr, "RPM is outside the supported range\n"); return 2;
    }
    if (g_dry) { printf("[dry] requested %.0f rpm, no hardware writes\n", rpm); return 0; }
    if (smc_open() != 0) { fprintf(stderr, "cannot open AppleSMC\n"); return 1; }
    fanset_t fans;
    if (!fanset_init(&fans, "all")) { fprintf(stderr, "no fan keys found\n"); return 1; }
    cfg_t cfg;
    cfg_defaults(&cfg);
    cfg.mode = mode;
    if (mode == MODE_FORCE) cfg.min_rpm = 0;
    bool wrote;
    /* fanset_apply clamps each fan to its own ceiling, so no clamp here. */
    if (!fanset_apply(&fans, &cfg, rpm, &wrote)) {
        fprintf(stderr, "SMC write failed - run as root\n");
        smc_close();
        return 1;
    }
    printf("%s -> %.0f rpm on %d fan%s\n", mode == MODE_FORCE ? "target" : "floor",
           rpm, fans.n, fans.n == 1 ? "" : "s");
    smc_close();
    return 0;
}

static int cmd_auto(void) {
    if (g_dry) { printf("[dry] system control unchanged\n"); return 0; }
    if (smc_open() != 0) { fprintf(stderr, "cannot open AppleSMC\n"); return 1; }
    fanset_t fans;
    if (!fanset_init(&fans, "all")) { fprintf(stderr, "no fan keys found\n"); return 1; }
    cfg_t cfg;
    cfg_defaults(&cfg);
    bool ok = fanset_release(&fans, &cfg);
    smc_close();
    if (!ok) {
        fprintf(stderr, "SMC write failed - run as root\n");
        return 1;
    }
    printf("fan returned to SMC automatic control\n");
    return 0;
}

/* Known M6 adapter: never probe F0Mn writes. Verify every selected fan. */
static int cmd_selftest(const char *conf) {
    if (g_dry) { fprintf(stderr, "selftest requires hardware writes; use daemon -n for preview\n"); return 2; }
    cfg_t cfg;
    cfg_defaults(&cfg);
    if (!cfg_load(&cfg, conf, false)) return 1;
    if (smc_open() != 0) return 1;
    fanset_t fans;
    if (!fanset_init(&fans, cfg.fans)) { smc_close(); return 1; }
    sensors_setup(&cfg);
    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);
    int result = 0;
    for (int step = 1; step < cfg.nsteps && !g_stop; step++) {
        bool wrote;
        double wanted = cfg.steps[step].rpm;
        if (!fanset_apply(&fans, &cfg, wanted, &wrote)) { result = 1; break; }
        int stable = 0;
        for (int sample = 0; sample < 15 && !g_stop; sample++) {
            double ctrl, peak;
            const char *hot = NULL;
            if (!sensors_sample(cfg.aggregate, &ctrl, &peak, &hot) || peak >= cfg.critical_temp) {
                result = 1; break;
            }
            bool reached = true;
            for (int i = 0; i < fans.n; i++) {
                double actual = 0, target = 0;
                double expected = fmin(wanted, fans.f[i].hw_max);
                if (!skey_read(&fans.f[i].actual, &actual) || !skey_read(&fans.f[i].target, &target) ||
                    fabs(actual - expected) > 150 || fabs(target - expected) > 2) reached = false;
            }
            stable = reached ? stable + 1 : 0;
            if (g_json) {
                printf("{\"type\":\"progress\",\"phase\":\"selftest\",\"step\":%d,\"total\":%d,\"rpm\":%.0f,\"stable\":%d}\n",
                       step, cfg.nsteps - 1, wanted, stable);
                fflush(stdout);
            }
            if (stable >= 2) break;
            sleep_sec(1);
        }
        if (result || stable < 2) { result = 1; break; }
        printf("PASS target=%.0f RPM on %d fan(s)\n", wanted, fans.n);
    }
    if (g_stop) result = 1;
    bool restored = fanset_release(&fans, &cfg);
    if (!restored) result = 1;
    if (g_json) printf("{\"type\":\"selftest\",\"passed\":%s,\"restored\":%s}\n", result == 0 ? "true" : "false", restored ? "true" : "false");
    smc_close();
    return result;
}

/* Size, type and access attributes for specific keys. The attribute byte is
 * the SMC's own statement of what it will let us do with the key. */
static int cmd_keyinfo(int argc, char **argv) {
    if (smc_open() != 0) { fprintf(stderr, "cannot open AppleSMC\n"); return 1; }
    if (g_json) printf("[");
    else printf("key   type   size attr value\n");
    for (int i = 0; i < argc; i++) {
        if (strlen(argv[i]) != 4 || strspn(argv[i], "#0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz") != 4) {
            smc_close(); return 2;
        }
        uint32_t key = smc_key(argv[i]), size = 0, type = 0;
        uint8_t attr = 0;
        int found = smc_key_info_full(key, &size, &type, &attr);
        char ts[5] = "";
        smc_key_str(type, ts);
        double v = 0;
        bool read = found == 0 && smc_read_num(key, size, type, &v) == 0 && isfinite(v);
        if (g_json) {
            printf("%s{\"key\":\"%s\",\"type\":\"%s\",\"size\":%u,\"attributes\":%u,\"found\":%s,\"value\":",
                   i ? "," : "", argv[i], ts, size, attr, found == 0 ? "true" : "false");
            if (read) printf("%.4f", v); else printf("null");
            printf("}");
        } else if (read) printf("%-5s [%.4s] %u 0x%02x %.2f\n", argv[i], ts, size, attr, v);
        else printf("%-5s unavailable\n", argv[i]);
    }
    if (g_json) printf("]\n");
    smc_close(); return 0;
}

/* Write one key and report precisely what the kernel returned, plus what the
 * key reads back afterwards. This is how we tell "the SMC refused us" apart
 * from "the SMC said yes and changed nothing". */
static int cmd_trywrite(const char *keyname, double val) {
    if (!isfinite(val) || !keyname || strlen(keyname) != 4 || strspn(keyname, "#0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz") != 4) {
        fprintf(stderr, "trywrite needs a 4-char key and a value\n");
        return 2;
    }
    if (smc_open() != 0) { fprintf(stderr, "cannot open AppleSMC\n"); return 1; }
    skey_t k;
    if (!skey_init(&k, keyname)) { fprintf(stderr, "%s: no such key\n", keyname); return 1; }

    double before = 0;
    skey_read(&k, &before);
    char ts[5];
    smc_key_str(k.type, ts);
    printf("%s [%s] size=%u  before=%.2f\n", keyname, ts, k.size, before);

    uint8_t buf[SMC_DATA_MAX] = {0};
    if (k.type == smc_key("flt ") && k.size == 4) {
        float f = (float)val;
        memcpy(buf, &f, 4);
    } else if (k.size == 1) {
        buf[0] = (uint8_t)val;
    } else if (k.size == 2) {
        uint16_t v = (uint16_t)val;
        buf[0] = (uint8_t)(v >> 8); buf[1] = (uint8_t)v;
    } else {
        fprintf(stderr, "unsupported type for trywrite\n"); return 1;
    }
    printf("writing       %.2f  (bytes:", val);
    for (uint32_t i = 0; i < k.size; i++) printf(" %02X", buf[i]);
    printf(")\n");

    int kr = 0;
    uint8_t result = 0, status = 0;
    int rc = g_dry ? -1 : smc_write_verbose(k.key, k.size, buf, &kr, &result, &status);
    const char *krname;
    switch ((unsigned)kr) {
    case 0x00000000: krname = "KERN_SUCCESS";           break;
    case 0xe00002c1: krname = "kIOReturnNotPrivileged";  break;
    case 0xe00002c2: krname = "kIOReturnBadArgument";    break;
    case 0xe00002c7: krname = "kIOReturnUnsupported";    break;
    case 0xe00002bc: krname = "kIOReturnError";          break;
    case 0xe00002d8: krname = "kIOReturnNotPermitted";   break;
    case 0xe00002eb: krname = "kIOReturnNotFound";       break;
    default:         krname = "(see IOReturn.h)";        break;
    }
    printf("kern_return   0x%08x  %s\n", (unsigned)kr, krname);
    printf("smc result    0x%02x    status 0x%02x\n", result, status);
    printf("write call    %s\n", rc == 0 ? "reported success" : "reported failure");

    double after1 = 0, after2 = 0;
    skey_read(&k, &after1);
    sleep_sec(2.0);
    skey_read(&k, &after2);
    printf("readback      %.2f immediately, %.2f after 2s\n", after1, after2);
    if (g_json) printf("{\"type\":\"write_diagnostic\",\"key\":\"%s\",\"requested\":%.4f,\"before\":%.4f,\"immediate\":%.4f,\"after\":%.4f,\"kern_return\":%u,\"smc_result\":%u,\"smc_status\":%u,\"write_succeeded\":%s}\n",
                       keyname, val, before, after1, after2, (unsigned)kr, result, status, rc == 0 ? "true" : "false");
    printf("verdict       %s\n",
           rc != 0                ? "the SMC refused the write" :
           fabs(after1 - val) >= 5 ? "SMC reported success but the value never changed" :
           fabs(after2 - val) >= 5 ? "took, then something reset it within 2s"
                                   : "value took and held");
    smc_close();
    return 0;
}

static int cmd_dump(const char *prefix) {
    if (strlen(prefix) != 2 || strspn(prefix, "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz") != 2) return 2;
    if (smc_open() != 0) { fprintf(stderr, "cannot open AppleSMC\n"); return 1; }
    static const char cs[] = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    int count = 0;
    if (g_json) printf("[");
    for (const char *a = cs; *a; a++) for (const char *b = cs; *b; b++) {
        char name[5] = { prefix[0], prefix[1], *a, *b, 0 };
        skey_t k;
        double v = 0;
        if (!skey_init(&k, name)) continue;
        char ts[5]; smc_key_str(k.type, ts);
        bool read = skey_read(&k, &v) && isfinite(v);
        if (g_json) {
            printf("%s{\"key\":\"%s\",\"type\":\"%s\",\"size\":%u,\"value\":", count++ ? "," : "", name, ts, k.size);
            if (read) printf("%.4f", v); else printf("null");
            printf("}");
        } else if (read) printf("%-5s [%s] %10.2f\n", name, ts, v);
        else printf("%-5s [%s] (undecoded, %u bytes)\n", name, ts, k.size);
    }
    if (g_json) printf("]\n");
    smc_close(); return 0;
}

/* -------------------------------------------------------------------- CLI */

static void usage(void) {
    printf(
"fanctl %s - temperature-driven fan control for Macs\n\n"
"  fanctl status              current temp, fan, mode and curve\n"
"  fanctl temps               each monitored sensor\n"
"  fanctl daemon              run the control loop (root; logs to stderr)\n"
"  fanctl -n daemon           dry run: decide and log, never touch the fan\n"
"  fanctl set <rpm>           one-shot: raise the fan floor (root)\n"
"  fanctl force <rpm>         one-shot: pin the fan exactly (root)\n"
"  fanctl auto                hand the fan back to macOS (root)\n"
"  fanctl pause               suspend control, fan back to macOS (root)\n"
"  fanctl resume              resume control (root)\n"
"  fanctl selftest            check that SMC writes stick (root)\n"
"  fanctl calibrate [cap C]   measure this machine and suggest a curve (root)\n"
"  fanctl -n calibrate        dry run: check the path, write nothing, no root\n"
"  fanctl dump <2-char pfx>   list SMC keys, e.g. 'fanctl dump Tp'\n"
"  fanctl keyinfo <KEY>...    type, size and access attributes for keys\n"
"  fanctl trywrite <KEY> <v>  write one key and report what the kernel said\n\n"
"  -c <file>   config file (default %s)\n"
"  -n          dry run (daemon only): never write to the SMC\n"
"  -j          status as JSON, for scripts and the menu bar app\n"
"  -v          log every poll, for tuning the curve\n", VERSION, DEFAULT_CONF);
}

int main(int argc, char **argv) {
    const char *conf = DEFAULT_CONF;
    int i = 1;
    for (; i < argc; i++) {
        if (!strcmp(argv[i], "-c") && i + 1 < argc) conf = argv[++i];
        else if (!strcmp(argv[i], "-n") || !strcmp(argv[i], "--dry-run")) g_dry = true;
        else if (!strcmp(argv[i], "-v")) g_verbose = true;
        else if (!strcmp(argv[i], "-j") || !strcmp(argv[i], "--json")) g_json = true;
        else break;
    }
    g_tty = isatty(1);

    if (i >= argc) { usage(); return 0; }

    const char *cmd = argv[i++];
    const char *arg = (i < argc) ? argv[i] : NULL;

    if (!strcmp(cmd, "status"))   return g_json ? status_json(conf) : cmd_status(conf);
    if (!strcmp(cmd, "temps"))    return cmd_temps(conf);
    if (!strcmp(cmd, "daemon"))   return run_daemon(conf);
    if (!strcmp(cmd, "auto"))     return cmd_auto();
    if (!strcmp(cmd, "pause"))    return cmd_pause(true);
    if (!strcmp(cmd, "resume"))   return cmd_pause(false);
    if (!strcmp(cmd, "selftest")) return cmd_selftest(conf);
    if (!strcmp(cmd, "calibrate")) return cmd_calibrate(conf, arg ? atof(arg) : 80.0);
    if (!strcmp(cmd, "dump"))     return cmd_dump(arg ? arg : "");
    if (!strcmp(cmd, "keyinfo"))  return cmd_keyinfo(argc - i, argv + i);
    if (!strcmp(cmd, "trywrite"))
        return cmd_trywrite(arg, (i + 1 < argc) ? atof(argv[i + 1]) : 0);
    if (!strcmp(cmd, "set") || !strcmp(cmd, "force")) {
        if (!arg) { fprintf(stderr, "%s needs an rpm value\n", cmd); return 2; }
        return cmd_set(atof(arg), !strcmp(cmd, "force") ? MODE_FORCE : MODE_FLOOR);
    }
    if (!strcmp(cmd, "-h") || !strcmp(cmd, "--help") || !strcmp(cmd, "help")) { usage(); return 0; }
    if (!strcmp(cmd, "-v") || !strcmp(cmd, "--version")) { printf("fanctl %s\n", VERSION); return 0; }

    fprintf(stderr, "unknown command '%s'\n", cmd);
    return 2;
}
