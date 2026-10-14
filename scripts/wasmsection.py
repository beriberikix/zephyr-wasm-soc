# SPDX-License-Identifier: Apache-2.0
"""Custom sections of a wasm module: read one, or append one.

A custom section is id 0, its size as unsigned LEB128, then its name (a
LEB128 length and the bytes) and its payload. Appended at the end of a
module, it changes nothing a runtime does, and every runtime skips it.
"""
import pathlib


def _uleb(n: int) -> bytes:
    out = bytearray()
    while True:
        byte = n & 0x7F
        n >>= 7
        out.append(byte | (0x80 if n else 0))
        if not n:
            return bytes(out)


def _read_uleb(data: bytes, pos: int) -> tuple[int, int]:
    n = shift = 0
    while True:
        byte = data[pos]
        pos += 1
        n |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            return n, pos


def sections(data: bytes) -> list[tuple[int, str | None, int, int]]:
    """Every section: (id, name for a custom one, start, end) of each."""
    if data[:4] != b"\0asm":
        raise ValueError("not a wasm module")
    out = []
    pos = 8
    while pos < len(data):
        start = pos
        sid = data[pos]
        size, pos = _read_uleb(data, pos + 1)
        end = pos + size
        name = None
        if sid == 0:
            nlen, npos = _read_uleb(data, pos)
            name = data[npos:npos + nlen].decode()
        out.append((sid, name, start, end))
        pos = end
    return out


def read(path: pathlib.Path, name: str) -> bytes | None:
    """The payload of the custom section called `name`, or None."""
    data = path.read_bytes()
    for sid, sname, start, end in sections(data):
        if sid == 0 and sname == name:
            size, pos = _read_uleb(data, start + 1)
            nlen, pos = _read_uleb(data, pos)
            return data[pos + nlen:end]
    return None


def replace(path: pathlib.Path, name: str, payload: bytes) -> None:
    """Append a custom section called `name`, dropping any it had."""
    data = path.read_bytes()
    kept = bytearray(data[:8])
    for sid, sname, start, end in sections(data):
        if not (sid == 0 and sname == name):
            kept += data[start:end]
    body = _uleb(len(name.encode())) + name.encode() + payload
    kept += b"\0" + _uleb(len(body)) + body
    path.write_bytes(bytes(kept))
