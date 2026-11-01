"""Independent offline MP4 timeline check; requires ffprobe (test only)."""
import json
import subprocess
import sys

path, expected = sys.argv[1], float(sys.argv[2])
result = json.loads(subprocess.check_output([
    'ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_frames',
    '-show_entries', 'format=duration:stream=duration:frame=best_effort_timestamp_time,pkt_duration_time,duration_time',
    '-of', 'json', path,
]))
frames = result['frames']
last = float(frames[-1]['best_effort_timestamp_time'])
end = last + float(frames[-1].get('duration_time', frames[-1].get('pkt_duration_time', 0)))
container = float(result['format']['duration'])
track = float(result['streams'][0]['duration'])
print(json.dumps(dict(frames=len(frames), lastFrame=last, sampleEnd=end,
                      containerDuration=container, trackDuration=track, expected=expected)))
assert abs(container - expected) < .05, 'container duration differs from real recording interval'
assert abs(track - expected) < .05, 'video track duration differs from real recording interval'
assert abs(end - expected) < .05, 'encoded samples do not reach the end'
assert last >= expected - .05, 'no actual decoded frame near the requested end'
