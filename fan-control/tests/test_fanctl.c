/* This translation unit never links AppleSMC. Every hardware call is a fake. */
#include <assert.h>
#define main fanctl_entrypoint
#include "../src/fanctl.c"
#undef main
static double mode_value, target_value = 1000, mock_temp = 34;
static unsigned writes;
uint32_t smc_key(const char *s) { return (uint32_t)(unsigned char)s[0]<<24 | (uint32_t)(unsigned char)s[1]<<16 | (uint32_t)(unsigned char)s[2]<<8 | (unsigned char)s[3]; }
void smc_key_str(uint32_t k,char out[5]) {for(int i=0;i<4;i++)out[i]=(char)(k>>(24-i*8));out[4]=0;}
uint8_t smc_last_result(void){return 0;}
int smc_open(void){return 0;}
void smc_close(void){}
int smc_key_info_full(uint32_t key,uint32_t *size,uint32_t *type,uint8_t *attr){
 char k[5];smc_key_str(key,k);
 if(strcmp(k,"F0Md")==0)return 1;
 if(strcmp(k,"FNum")&&strcmp(k,"F0Ac")&&strcmp(k,"F0Tg")&&strcmp(k,"F0Mx")&&strcmp(k,"F0Mn")&&strcmp(k,"F0md")&&strcmp(k,"Tp05"))return 1;
 *size=4;*type=smc_key("flt ");*attr=0;return 0;
}
int smc_key_info(uint32_t key,uint32_t *size,uint32_t *type){uint8_t attr;return smc_key_info_full(key,size,type,&attr);}
int smc_read_num(uint32_t key,uint32_t size,uint32_t type,double *out){
 char k[5];smc_key_str(key,k);*out=!strcmp(k,"FNum")?1:!strcmp(k,"F0md")?mode_value:!strcmp(k,"F0Mx")?4900:!strcmp(k,"Tp05")?mock_temp:target_value;return 0;
}
int smc_write_num(uint32_t key,uint32_t size,uint32_t type,double value){
 char k[5];smc_key_str(key,k);assert(strcmp(k,"F0Mn")!=0);writes++;if(!strcmp(k,"F0md"))mode_value=value;else if(!strcmp(k,"F0Tg"))target_value=value;else assert(0);return 0;
}
int smc_read_raw(uint32_t key,uint32_t size,uint8_t *buf){memset(buf,0,size);return 0;}
int smc_write_raw(uint32_t key,uint32_t size,const uint8_t *buf){assert(0);return 1;}
int smc_write_verbose(uint32_t key,uint32_t size,const uint8_t *buf,int *kr,uint8_t *result,uint8_t *status){assert(0);return 1;}
int main(void){
 cfg_t c;assert(cfg_load(&c,"config/fanctl.conf",false));assert(c.nsteps==5);
 double dwell[MAX_STEPS];for(int i=0;i<MAX_STEPS;i++)dwell[i]=-1;
 int level=policy_step(&c,61,10,1,0,dwell);assert(level==3);
 assert(policy_step(&c,30,11,1,level,dwell)==3);
 assert(policy_step(&c,30,40,1,level,dwell)==3);
 assert(policy_step(&c,30,41,1,level,dwell)==0);
 for(int i=0;i<MAX_STEPS;i++)dwell[i]=1;
 assert(policy_step(&c,30,50,10,3,dwell)==3); /* telemetry gap resets dwell */
 fanset_t fans;assert(fanset_init(&fans,"0"));assert(fans.n==1);bool wrote;
 assert(fanset_apply(&fans,&c,2170,&wrote));assert(mode_value==1&&target_value==2170&&wrote);
 assert(fanset_apply(&fans,&c,1000,&wrote));assert(mode_value==0); /* curve base returns to Apple */
 assert(cmd_set(1000,MODE_FORCE)==0);assert(mode_value==1&&target_value==1000); /* explicit manual differs */
 assert(cmd_auto()==0);assert(mode_value==0);
 unsigned before=writes;g_dry=true;
 assert(cmd_set(2170,MODE_FORCE)==0);assert(cmd_auto()==0);assert(writes==before);
 g_dry=false;assert(cmd_set(NAN,MODE_FORCE)==2);assert(cmd_set(INFINITY,MODE_FORCE)==2);assert(writes==before);
 sensors_setup(&c); /* absent configured keys fail closed, rather than silently using Tp05 only */
 assert(!g_sensor_setup_ok);
 char path[]="/tmp/archipel-smc-test-XXXXXX";int fd=mkstemp(path);assert(fd>=0);FILE *config=fdopen(fd,"w");assert(config);
 fprintf(config,"mode=force\nup_delay=0\nsensors=Tp05\nfans=0\ncurve=0:1000,40:2170,70:4900\ncritical_temp=70\n");fclose(config);
 assert(cmd_selftest(path)==0);assert(mode_value==0);
 mock_temp=75;assert(cmd_selftest(path)==1);assert(mode_value==0);
 mock_temp=34;g_stop=1;assert(cmd_selftest(path)==1);assert(mode_value==0);g_stop=0;unlink(path);
 puts("fanctl policy, force-only writes, dry-run and sensor fail-closed checks passed");return 0;
}
