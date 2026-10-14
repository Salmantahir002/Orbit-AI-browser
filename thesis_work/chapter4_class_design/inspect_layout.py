from pathlib import Path
from zipfile import ZipFile
import json
import pypdfium2 as pdfium
from PIL import ImageChops, Image
from pypdf import PdfReader

WORK = Path(__file__).resolve().parent
ROOT = WORK.parents[1]
QA = WORK / 'qa'
pdf = pdfium.PdfDocument(str(QA / 'word-preview.pdf'))
reader = PdfReader(str(QA / 'word-preview.pdf'))
report = []
for i in range(len(pdf)):
    page = pdf[i]
    im = page.render(scale=1.8).to_pil().convert('RGB')
    im.save(QA / f'page-{i+1}.png')
    bbox = ImageChops.difference(im, Image.new('RGB', im.size, 'white')).convert('L').point(lambda x: 255 if x > 30 else 0).getbbox()
    top = im.height * (25.4 / 297)
    usable = im.height * ((297-50.8)/297)
    occupancy = round(100*(bbox[3]-top)/usable, 1) if bbox else 0
    text = reader.pages[i].extract_text()
    report.append({'page':i+1, 'text_area_occupied_percent':occupancy, 'words':len(text.split()), 'last_text':text[-160:]})
with ZipFile(ROOT / 'Chapter_4_Section_4_3_Class_Design.docx') as archive:
    media = [name for name in archive.namelist() if name.startswith('word/media/')]
print(json.dumps({'pages':len(pdf), 'embedded_media':len(media), 'layout':report}, indent=2))
(QA / 'layout-report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
