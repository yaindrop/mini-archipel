"""Reproduce a native MP4 movie/edit tail longer than its real sample table."""
import struct
import sys

src, dst = sys.argv[1:]
data = bytearray(open(src, 'rb').read())
changed = set()
movie_scale = None

def atoms(start, end):
    global movie_scale
    while start < end:
        size, kind = struct.unpack_from('>I4s', data, start)
        header = 8
        if size == 1:
            size = struct.unpack_from('>Q', data, start + 8)[0]
            header = 16
        elif size == 0:
            size = end - start
        assert size >= header and start + size <= end, 'unexpected fixture atom'
        payload = start + header
        if kind in (b'moov', b'trak', b'edts', b'mdia'):
            atoms(payload, start + size)
        elif kind == b'mvhd':
            assert data[payload] == 0
            movie_scale = struct.unpack_from('>I', data, payload + 12)[0]
            struct.pack_into('>I', data, payload + 16, movie_scale * 3)
            changed.add(kind)
        elif kind == b'tkhd':
            assert data[payload] == 0
            assert movie_scale is not None
            struct.pack_into('>I', data, payload + 20, movie_scale * 3)
            changed.add(kind)
        elif kind == b'elst':
            assert data[payload] == 0 and struct.unpack_from('>I', data, payload + 4)[0] == 1
            struct.pack_into('>I', data, payload + 8, movie_scale * 3)
            changed.add(kind)
        start += size

atoms(0, len(data))
assert changed == {b'mvhd', b'tkhd', b'elst'}, changed
with open(dst, 'xb') as output:
    output.write(data)
print('Created deterministic 3-second movie/edit header with unchanged 1.5-second samples')
