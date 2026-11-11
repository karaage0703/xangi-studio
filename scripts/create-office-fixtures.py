"""Generate test documents: uv run --with python-docx --with python-pptx python scripts/create-office-fixtures.py"""
from pathlib import Path
from docx import Document
from pptx import Presentation
root = Path(__file__).resolve().parents[1] / "tests" / "fixtures"
root.mkdir(exist_ok=True)
doc = Document()
doc.core_properties.author = "Test fixture"
doc.add_heading("Document page 1", 0)
doc.add_paragraph("Review this first page.")
doc.add_page_break()
doc.add_heading("Document page 2", 0)
doc.add_paragraph("Review this second page.")
doc.save(root / "two-pages.docx")
slides = Presentation()
slides.core_properties.author = "Test fixture"
for i in range(2):
    slide = slides.slides.add_slide(slides.slide_layouts[1])
    slide.shapes.title.text = f"Slide {i+1}"
    slide.placeholders[1].text = f"Review the layout of slide {i+1}."
slides.save(root / "two-slides.pptx")

# Legacy binary DOC is also generated through the installed LibreOffice CLI.
import tempfile
import subprocess
import shutil
with tempfile.TemporaryDirectory(prefix="review-doc-fixture-") as directory:
    temporary = Path(directory)
    subprocess.run(["libreoffice", f"-env:UserInstallation={(temporary / 'profile').as_uri()}", "--headless", "--convert-to", "doc", "--outdir", directory, str(root / "two-pages.docx")], check=True, timeout=60)
    shutil.copy(temporary / "two-pages.doc", root / "two-pages.doc")
