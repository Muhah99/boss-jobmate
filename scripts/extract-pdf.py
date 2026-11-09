import json
import sys
from pypdf import PdfReader

reader = PdfReader(sys.argv[1])
text = "\n\n".join(page.extract_text() or "" for page in reader.pages)
print(json.dumps({"text": text, "pages": len(reader.pages)}, ensure_ascii=True))
