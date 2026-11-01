"""Bounded, explicit native-input requests; no platform calls during validation."""
import math
import re

KINDS = {"activate", "move", "click", "doubleClick", "middleClick", "rightClick", "mouseHold", "drag", "scroll", "key", "text"}
MODIFIERS = {"command", "shift", "option", "control"}
KEYS = set("abcdefghijklmnopqrstuvwxyz0123456789") | {"Return", "Tab", "space", "delete", "Escape", "Left", "Right", "Up", "Down", "Home", "End", "PageUp", "PageDown", "ForwardDelete", "equal", "minus", "rightBracket", "leftBracket", "quote", "semicolon", "backslash", "comma", "slash", "period", "grave"} | {f"F{i}" for i in range(1, 13)}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def number(value, low, high):
    return type(value) in (int, float) and math.isfinite(value) and low <= value <= high


def integer(value, low, high):
    return type(value) is int and low <= value <= high


def validate_input(request):
    require(isinstance(request.get("mode"), str) and request.get("mode") in {"preflight", "execute"}, "Input requires explicit preflight/execute mode")
    require(integer(request.get("timeout", 15), 1, 120), "Native input has a bounded 1–120 second timeout (default 15)")
    target = request.get("target")
    require(isinstance(target, dict) and set(target) <= {"pid", "bundle_id", "window_id", "frame", "observed_at_ms", "title", "hit_text", "hit_role"}, "Invalid input target fields")
    require(integer(target.get("pid"), 1, 2147483647) and integer(target.get("window_id"), 1, 4294967295), "A real PID/window ID is required")
    require(isinstance(target.get("bundle_id"), str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,254}", target["bundle_id"]), "Invalid app bundle ID")
    require(number(target.get("observed_at_ms"), 1, 1e16), "Fresh observed target time is required")
    require("title" not in target or isinstance(target["title"], str) and len(target["title"].encode("utf-16-le")) // 2 <= 1000, "Invalid optional target title")
    frame = target.get("frame")
    require(isinstance(frame, dict) and set(frame) == {"x", "y", "width", "height"}, "Observed frame is required")
    require(all(number(frame[k], -100000, 100000) for k in frame) and frame["width"] > 0 and frame["height"] > 0, "Invalid observed frame")
    coordinates = request.get("coordinates")
    require(isinstance(coordinates, dict) and set(coordinates) <= {"space", "unit", "display_id"}, "Explicit coordinate semantics required")
    require(isinstance(coordinates.get("space"), str) and isinstance(coordinates.get("unit"), str) and coordinates.get("space") in {"screen", "window"} and coordinates.get("unit") in {"points", "pixels"}, "Invalid coordinate space/unit")
    require("display_id" not in coordinates or integer(coordinates["display_id"], 1, 4294967295), "Invalid display ID")
    require(coordinates["unit"] != "pixels" or "display_id" in coordinates, "Pixels require a real display ID")
    action = request.get("action")
    require(isinstance(action, dict) and isinstance(action.get("kind"), str) and action["kind"] in KINDS, "Unsupported input action")
    kind = action["kind"]
    for field, maximum in [("hit_text", 1000), ("hit_role", 100)]:
        require(field not in target or isinstance(target[field], str) and 1 <= len(target[field].encode("utf-16-le")) // 2 <= maximum, "Invalid observed hit expectation")
    require(not ({"hit_text", "hit_role"} & set(target)) or kind in {"move", "click", "doubleClick", "middleClick", "rightClick", "mouseHold", "drag", "scroll"}, "Hit expectations require a pointer action")
    allowed = {"kind", "easing", "modifiers"} if kind != "activate" else {"kind"}
    if kind in {"move", "click", "doubleClick", "middleClick", "rightClick", "mouseHold", "drag", "scroll"}:
        allowed |= {"move_seconds", "settle_seconds"}
    if kind in {"move", "click", "doubleClick", "middleClick", "rightClick", "mouseHold", "scroll"}:
        allowed |= {"x", "y"}
        require(number(action.get("x"), -100000, 100000) and number(action.get("y"), -100000, 100000), "Finite coordinates required")
    if kind in {"click", "doubleClick", "middleClick", "rightClick", "mouseHold", "drag"}:
        allowed |= {"button"}
        require(isinstance(action.get("button", "left"), str) and action.get("button", "left") in {"left", "middle", "right"}, "Invalid button")
    if kind in {"click", "doubleClick", "middleClick", "rightClick", "mouseHold", "key"}:
        allowed |= {"hold_seconds"}
    if kind == "drag":
        allowed |= {"points"}
        points = action.get("points")
        require(isinstance(points, list) and 2 <= len(points) <= 1000, "Drag requires 2–1000 timed points")
        previous = -1
        for point in points:
            require(isinstance(point, dict) and set(point) == {"t", "x", "y"} and all(number(point[k], -100000, 100000) for k in point), "Invalid drag point")
            require(point["t"] > previous, "Path times must strictly increase")
            previous = point["t"]
        require(points[0]["t"] == 0 and .1 <= previous <= 60, "Drag must span 0.1–60 seconds")
    if kind == "scroll":
        allowed |= {"delta_x", "delta_y", "duration"}
        require(integer(action.get("delta_x", 0), -10000, 10000) and integer(action.get("delta_y", 0), -10000, 10000) and (action.get("delta_x", 0) != 0 or action.get("delta_y", 0) != 0), "Nonzero bounded pixel scroll required")
        require(number(action.get("duration", .5), .05, 60), "Invalid scroll duration")
    if kind == "key":
        allowed |= {"key", "key_code"}
        require(("key" in action) != ("key_code" in action), "Specify one key name or virtual key code")
        require(isinstance(action.get("key"), str) and action.get("key") in KEYS if "key" in action else integer(action["key_code"], 0, 127), "Unsupported key")
        require(not any(action.get("key_code") == code and name in action.get("modifiers", []) for name, code in {"command":55,"shift":56,"option":58,"control":59}.items()) if isinstance(action.get("modifiers", []), list) else False, "Main key must differ from modifiers")
    if kind == "text":
        allowed |= {"text", "text_chunk_units"}
        require(isinstance(action.get("text"), str) and 1 <= len(action["text"].encode("utf-16-le")) // 2 <= 16000, "Text requires 1–16000 UTF-16 units")
    require(not set(action) - allowed, "Unknown action fields")
    require(number(action.get("move_seconds", 1), 0, 30) and number(action.get("settle_seconds", .2), 0, 5) and number(action.get("hold_seconds", .08), .01, 60), "Invalid motion/settle/hold duration")
    require(isinstance(action.get("easing", "smoothstep"), str) and action.get("easing", "smoothstep") in {"linear", "smoothstep", "smootherstep"}, "Unsupported easing")
    mods = action.get("modifiers", [])
    require(isinstance(mods, list) and len(mods) <= 4 and all(isinstance(x, str) and x in MODIFIERS for x in mods) and len(set(mods)) == len(mods), "Invalid modifier chord")
    require(kind not in {"move", "text"} or not mods, "Move-only/text cannot hold modifiers")

    require(integer(action.get("text_chunk_units", 1), 1, 20), "Text chunks require 1–20 UTF-16 units")
    estimated = (action.get("move_seconds", 1) + action.get("settle_seconds", .2)) if kind in {"move", "click", "doubleClick", "middleClick", "rightClick", "mouseHold", "drag", "scroll"} else 0
    if kind == "drag":
        estimated += points[-1]["t"]
    if kind == "scroll":
        estimated += action.get("duration", .5)
    if kind in {"click", "middleClick", "rightClick", "mouseHold", "key"}:
        estimated += action.get("hold_seconds", 1 if kind == "mouseHold" else .06 if kind == "key" else .08)
    if kind == "doubleClick":
        estimated += 2 * action.get("hold_seconds", .08) + .12
    if kind == "text":
        units = 0
        chunks = 1
        for char in action["text"]:
            size = len(char.encode("utf-16-le")) // 2
            if units and units + size > action.get("text_chunk_units", 1):
                chunks += 1
                units = 0
            units += size
        estimated += chunks * .06
    require(estimated + .25 < request.get("timeout", 15), "Action exceeds timeout; increase the bounded timeout or select text chunks")
