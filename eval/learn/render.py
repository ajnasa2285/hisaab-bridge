"""Renders the invented challans of eval/learn/answers.json to eval/learn/images/<id>.png.

Every name, number and phone in answers.json is invented. Uses only Pillow and Windows' own fonts
(no npm dependency). Run from anywhere:  python eval/learn/render.py
"""
import json
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.join(os.environ.get('WINDIR', r'C:\Windows'), 'Fonts')
W, H = 1000, 860
INK = (20, 20, 20)
BLUE = (25, 45, 140)


def font(name, size):
    return ImageFont.truetype(os.path.join(FONTS, name), size)


PRINT = font('arial.ttf', 22)
BOLD = font('arialbd.ttf', 22)
SMALL = font('arial.ttf', 17)
TITLE = font('arialbd.ttf', 36)
HAND = font('segoesc.ttf', 28)
HAND2 = font('Inkfree.ttf', 30)


def header(d, doc, title):
    d.text((W // 2, 40), doc['supplier'], font=TITLE, fill=INK, anchor='mm')
    d.text((W // 2, 80), 'Main Road, Demo Market  |  Mob: ' + doc['phone'], font=SMALL, fill=INK, anchor='mm')
    d.text((W // 2, 115), title, font=BOLD, fill=INK, anchor='mm')
    d.line((40, 135, W - 40, 135), fill=INK, width=2)
    label = 'Challan No.' if doc['layout'] in ('handwritten-overwrite', 'weight-beside-qty', 'ordered-vs-supplied') else 'Bill No.'
    d.text((50, 155), f"{label}: {doc['challanNo']}", font=BOLD, fill=INK)
    d.text((W - 50, 155), f"Date: {doc['date']}", font=BOLD, fill=INK, anchor='ra')
    d.text((50, 190), 'M/s. Site Account (party)', font=PRINT, fill=INK)


def table(d, top, cols, heads, rows, row_h=56):
    """cols: x positions of column borders; heads: header texts (may be ''); rows: list of lists of str."""
    left, right = cols[0], cols[-1]
    bottom = top + row_h * (len(rows) + 1) + row_h
    d.rectangle((left, top, right, bottom), outline=INK, width=2)
    for x in cols[1:-1]:
        d.line((x, top, x, bottom), fill=INK, width=1)
    d.line((left, top + row_h, right, top + row_h), fill=INK, width=2)
    for i, h in enumerate(heads):
        d.text(((cols[i] + cols[i + 1]) // 2, top + row_h // 2), h, font=BOLD, fill=INK, anchor='mm')
    centres = []
    for r, row in enumerate(rows):
        y = top + row_h * (r + 1) + row_h // 2
        centres.append(y)
        for i, cell in enumerate(row):
            if cell is None:
                continue
            if i <= 1:
                d.text((cols[i] + 12, y), cell, font=PRINT, fill=INK, anchor='lm')
            else:
                d.text((cols[i + 1] - 14, y), cell, font=PRINT, fill=INK, anchor='rm')
    return centres, bottom


def footer(d, y):
    d.text((50, y + 40), "Receiver's Sign:", font=PRINT, fill=INK)
    d.text((240, y + 28), 'R.k.', font=HAND, fill=BLUE)
    d.text((W - 50, y + 40), 'For ' + 'Supplier', font=PRINT, fill=INK, anchor='ra')


def rate_left(d, doc):
    header(d, doc, 'BILL / CHALLAN')
    rows = [[str(i + 1), f"{it['name']} - {it['unit'].capitalize()}", it['rate'], it['qty'], it['amount']] for i, it in enumerate(doc['items'])]
    _, bottom = table(d, 240, [40, 110, 520, 680, 800, 960], ['S.No', 'Particulars', '', '', 'Amount'], rows)
    footer(d, bottom)


def rate_times_qty(d, doc):
    header(d, doc, 'ESTIMATE / CHALLAN')
    rows = [[str(i + 1), f"{it['name']} ({it['unit']})", f"{it['rate']} x {it['qty']}", it['amount']] for i, it in enumerate(doc['items'])]
    _, bottom = table(d, 240, [40, 110, 540, 780, 960], ['S.No', 'Description', '', 'Amount'], rows)
    footer(d, bottom)


def handwritten_overwrite(d, doc):
    header(d, doc, 'DELIVERY CHALLAN')
    cols = [40, 110, 560, 700, 960]
    rows = [[str(i + 1), it['name'], it['unit'].capitalize(), None] for i, it in enumerate(doc['items'])]
    centres, bottom = table(d, 240, cols, ['Sr.', 'Material', 'Unit', 'Quantity'], rows)
    for it, y in zip(doc['items'], centres):
        if 'printedQty' in it:
            x = cols[3] + 30
            d.text((x, y), it['printedQty'], font=PRINT, fill=INK, anchor='lm')
            wid = d.textlength(it['printedQty'], font=PRINT)
            d.line((x - 6, y + 2, x + wid + 6, y - 4), fill=BLUE, width=3)
            d.line((x - 6, y - 6, x + wid + 6, y + 4), fill=BLUE, width=3)
            d.text((x + wid + 40, y + 2), it['qty'], font=HAND, fill=BLUE, anchor='lm')
        else:
            d.text((cols[3] + 30, y + 2), it['qty'], font=HAND2, fill=BLUE, anchor='lm')
    footer(d, bottom)


def weight_beside_qty(d, doc):
    header(d, doc, 'DELIVERY CHALLAN')
    rows = [[str(i + 1), it['name'], it['weight'], it['qty']] for i, it in enumerate(doc['items'])]
    _, bottom = table(d, 240, [40, 110, 560, 800, 960], ['Sr.', 'Description', 'Wt. Kg', 'Nos'], rows)
    footer(d, bottom)


def ordered_vs_supplied(d, doc):
    header(d, doc, 'DELIVERY CHALLAN')
    rows = []
    for i, it in enumerate(doc['items']):
        bal = int(it['ordered']) - int(it['qty'])
        rows.append([str(i + 1), it['name'], it['unit'].capitalize(), it['ordered'], it['qty'], str(bal) if bal else '-'])
    _, bottom = table(d, 240, [40, 100, 450, 560, 690, 830, 960], ['Sr.', 'Item', 'Unit', 'Ord. Qty', 'Supp.', 'Bal.'], rows)
    footer(d, bottom)


def rate_x_qty_compact(d, doc):
    header(d, doc, 'CASH MEMO / CHALLAN')
    rows = [[str(i + 1), f"{it['name']} ({it['unit']})", f"{it['rate']}x{it['qty']}", it['amount']] for i, it in enumerate(doc['items'])]
    _, bottom = table(d, 240, [40, 110, 560, 760, 960], ['No.', 'Item', '', 'Rs.'], rows)
    footer(d, bottom)


def weighbridge_net(d, doc):
    header(d, doc, 'WEIGHMENT SLIP CUM CHALLAN')
    rows = [[str(i + 1), it['name'], it['gross'], it['tare'], f"{int(it['qty']):,}"] for i, it in enumerate(doc['items'])]
    _, bottom = table(d, 240, [40, 100, 400, 590, 780, 960], ['Trip', 'Material', 'Gross', 'Tare', 'Net (kg)'], rows)
    footer(d, bottom)


def qty_after_amount(d, doc):
    header(d, doc, 'BILL / CHALLAN')
    rows = [[str(i + 1), f"{it['name']} ({it['unit']})", it['rate'], it['amount'], it['qty']] for i, it in enumerate(doc['items'])]
    _, bottom = table(d, 240, [40, 110, 500, 640, 830, 960], ['S.No', 'Particulars', 'Rate', 'Amount', ''], rows)
    footer(d, bottom)


LAYOUTS = {
    'rate-x-qty-compact': rate_x_qty_compact,
    'weighbridge-net': weighbridge_net,
    'qty-after-amount': qty_after_amount,
    'rate-left': rate_left,
    'rate-times-qty': rate_times_qty,
    'handwritten-overwrite': handwritten_overwrite,
    'weight-beside-qty': weight_beside_qty,
    'ordered-vs-supplied': ordered_vs_supplied,
}


def main():
    with open(os.path.join(HERE, 'answers.json'), encoding='utf-8') as f:
        docs = json.load(f)['docs']
    out = os.path.join(HERE, 'images')
    os.makedirs(out, exist_ok=True)
    for doc in docs:
        img = Image.new('RGB', (W, H), (250, 248, 240))
        d = ImageDraw.Draw(img)
        LAYOUTS[doc['layout']](d, doc)
        # A slight tilt, like a phone photo of a flat sheet; seeded so renders are repeatable.
        angle = random.Random(doc['id']).uniform(-0.8, 0.8)
        img = img.rotate(angle, resample=Image.BICUBIC, expand=False, fillcolor=(250, 248, 240))
        img = img.quantize(colors=32)
        path = os.path.join(out, doc['id'] + '.png')
        img.save(path, optimize=True)
        print(doc['id'], os.path.getsize(path), 'bytes')


if __name__ == '__main__':
    sys.exit(main())
