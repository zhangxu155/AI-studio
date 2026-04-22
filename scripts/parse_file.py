#!/usr/bin/env python3
import base64
import io
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def parse_py_java(data: bytes) -> str:
    return normalize(data.decode("utf-8", errors="ignore"))


def parse_pdf(data: bytes) -> str:
    raw = data.decode("latin-1", errors="ignore")
    chunks = re.findall(r"\((.*?)\)\s*Tj", raw, flags=re.S)
    return normalize(" ".join(chunks))


def xml_text(xml_bytes: bytes) -> str:
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return ""
    return normalize(" ".join(t for t in root.itertext() if t))


def parse_docx(data: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        xml = zf.read("word/document.xml")
    return xml_text(xml)


def parse_pptx(data: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = sorted([n for n in zf.namelist() if n.startswith("ppt/slides/slide") and n.endswith(".xml")])
        texts = [xml_text(zf.read(name)) for name in names]
    return normalize("\n".join(t for t in texts if t))


def parse_xlsx(data: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        texts = []
        shared = []
        if "xl/sharedStrings.xml" in zf.namelist():
            shared_root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            shared = [normalize(" ".join(t for t in si.itertext())) for si in shared_root.findall("{*}si")]

        sheet_names = sorted([n for n in zf.namelist() if n.startswith("xl/worksheets/sheet") and n.endswith(".xml")])
        for idx, sheet_name in enumerate(sheet_names, start=1):
            root = ET.fromstring(zf.read(sheet_name))
            lines = []
            for c in root.findall('.//{*}c'):
                cell_ref = c.attrib.get('r', '')
                v = c.find('{*}v')
                if v is None or v.text is None:
                    continue
                val = v.text
                if c.attrib.get('t') == 's':
                    try:
                        val = shared[int(val)]
                    except Exception:
                        pass
                lines.append(f"{cell_ref}: {val}")
            texts.append(f"[Sheet{idx}] " + " ; ".join(lines))

    return normalize("\n".join(texts))


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Missing filename"}, ensure_ascii=False))
        return

    filename = sys.argv[1]
    ext = filename.lower().rsplit('.', 1)[-1] if '.' in filename else ''
    b64 = sys.stdin.read().strip()
    data = base64.b64decode(b64)

    try:
        if ext in ("py", "java"):
            text = parse_py_java(data)
        elif ext == "pdf":
            text = parse_pdf(data)
        elif ext == "docx":
            text = parse_docx(data)
        elif ext == "pptx":
            text = parse_pptx(data)
        elif ext in ("xlsx", "xls"):
            text = parse_xlsx(data)
        else:
            raise ValueError(f"Unsupported file extension: .{ext}")

        print(json.dumps({"success": True, "text": text}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
