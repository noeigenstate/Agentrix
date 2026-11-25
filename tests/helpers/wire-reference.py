"""Independent Python 3.6-compatible reader for the shared wire vectors."""
import json
import re
import sys


def version_of(received, version, versions, channel=None):
    if type(version) not in (int, float) or not 1 <= version <= 9007199254740991 or version not in versions:
        if isinstance(received, str):
            label = re.sub(r"[\r\n\0]", " ", received[:80])
        elif isinstance(received, (dict, list)):
            label = "[object Object]" if isinstance(received, dict) else "[object Array]"
        else:
            label = json.dumps(received)
        raise ValueError("wire.unsupported_version", "unsupported version " + label, channel)


def envelope(text, case, versions):
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError("wire.invalid", "expected a JSON object")
    file_format = case.get("format")
    key = "version" if file_format else "v"
    legacy = key not in value
    version = value.get(key, 0)
    if not legacy or not case.get("legacy", True):
        version_of("0 (missing)" if legacy else version, version, versions)
    if file_format and (not legacy or "format" in value) and value.get("format") != file_format:
        raise ValueError("wire.invalid", "expected format " + file_format)
    return {"value": value, "version": version, "legacy": legacy}


def key_values(text, case, versions):
    if len(text.encode("utf-8")) > 16 * 1024:
        raise ValueError("wire.invalid", "expected UTF-8 text up to 16 KiB")
    rows = (text[1:] if text.startswith("\ufeff") else text).split("\n")
    if rows[-1] == "":
        rows.pop()
    values = {}
    for row in rows:
        key, equals, value = row.partition("=")
        if not equals or not re.fullmatch(r"[a-z][a-z0-9_]*", key) or "\r" in value or "\0" in value or key in values:
            raise ValueError("wire.invalid", "invalid or repeated key=value record")
        values[key] = value
    file_format = values.get("format", "")
    if not re.fullmatch(r"agentrix\.[a-z][a-z0-9-]*", file_format) or case.get("format", file_format) != file_format or "version" not in values:
        raise ValueError("wire.invalid", "expected format and version")
    received = values["version"]
    version = int(received) if len(received) <= 16 and re.fullmatch(r"[1-9][0-9]*", received) else None
    version_of(received, version, versions, file_format)
    return values


def run_case(case):
    text = case["input"]
    if "repeat" in case:
        text += case["repeat"][0] * case["repeat"][1]
    channel = case.get("channel") or case.get("format") or ("JSONL" if case["kind"] == "envelope" else "key=value")
    versions = case.get("versions", [1])
    try:
        reader = envelope if case["kind"] == "envelope" else key_values
        return {"value": reader(text, case, versions)}
    except ValueError as error:
        if len(error.args) not in (2, 3):
            raise
        source = (error.args[2] or channel) if len(error.args) == 3 else channel
        return {"code": error.args[0], "message": source + ": " + error.args[1]}


with open(sys.argv[1], encoding="utf-8") as fixture:
    print(json.dumps([run_case(case) for case in json.load(fixture)]))
