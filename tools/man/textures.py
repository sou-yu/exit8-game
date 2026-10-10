# GLB から取り出した画像を JPEG に変換する（顔は 2048 のまま、その他は用途に見合う大きさへ）
# usage: textures.py <extract-images の出力フォルダ> <出力フォルダ>
import os
import sys
from PIL import Image
src = sys.argv[1]; out = sys.argv[2]
os.makedirs(out, exist_ok=True)
jobs = [  # (元画像, 出力名, 長辺, 品質)
    ('n_img0.png', 'bag_normal.jpg', 512, 92),
    ('n_img1.png', 'bag_albedo.jpg', 512, 88),
    ('n_img2.png', 'cloth.jpg', 1448, 88),
    ('n_img3.png', 'head.jpg', 2048, 88),
    ('s_img3.png', 'head_smile.jpg', 2048, 88),
    ('n_img4.png', 'teeth.jpg', 512, 88),
]
for name, oname, size, q in jobs:
    im = Image.open(f'{src}/{name}').convert('RGB')
    if max(im.size) > size:
        k = size / max(im.size)
        im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
    im.save(f'{out}/{oname}', 'JPEG', quality=q, optimize=True, subsampling=0 if 'normal' in oname else 2)
    print(oname, im.size)
