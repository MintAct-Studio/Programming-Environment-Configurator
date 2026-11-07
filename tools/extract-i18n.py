"""抽取需要翻译的文案（收紧版）。

排除：
  - 带 ${} 插值的模板片段（单独人工处理）
  - 多行 / 含代码符号的字符串
  - 纯符号、纯空白
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CJK = re.compile('[\u4e00-\u9fff]')
STR = re.compile(r"'([^'\\]*(?:\\.[^'\\]*)*)'|\"([^\"\\]*(?:\\.[^\"\\]*)*)\"|`([^`\\]*(?:\\.[^`\\]*)*)`", re.S)
TAG = re.compile(r'>([^<>]+)<')

CODEY = re.compile(r'[{};]|=>|\$\{|\\\\n|\x27\s*\+')

msgids = {}


def add(s):
    s = s.strip()
    if not s or not CJK.search(s):
        return
    if len(s) > 120:
        return          # 超长段落单独处理
    if CODEY.search(s):
        return
    msgids.setdefault(s, '')


for rel in ['src/renderer/app.js', 'src/renderer/splash.js', 'src/renderer/splash-quotes.js',
            'src/main/main.js', 'src/core/recommend.js', 'src/core/validate.js',
            'src/core/logparse.js', 'src/core/installer.js']:
    p = os.path.join(ROOT, rel)
    if not os.path.exists(p):
        continue
    src = open(p, encoding='utf-8').read()
    for m in STR.finditer(src):
        add(m.group(1) or m.group(2) or m.group(3) or '')

html = open(os.path.join(ROOT, 'src/renderer/index.html'), encoding='utf-8').read()
for m in TAG.finditer(html):
    add(m.group(1))
for m in re.finditer(r'(?:placeholder|title|aria-label)="([^"]+)"', html):
    add(m.group(1))

for rel in ['src/data/components.json', 'src/data/scenarios.json']:
    p = os.path.join(ROOT, rel)
    if not os.path.exists(p):
        continue
    data = json.load(open(p, encoding='utf-8'))

    def walk(node):
        if isinstance(node, dict):
            for k, v in node.items():
                if k in ('name', 'desc', 'why', 'note', 'label', 'hint', 'title') and isinstance(v, str):
                    add(v)
                else:
                    walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(data)

out = os.path.join(ROOT, 'src/i18n/_msgids.json')
json.dump({k: '' for k in sorted(msgids)}, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('干净条目:', len(msgids), '| 总字符:', sum(len(k) for k in msgids))

# 同时输出一份「含插值的模板」，人工处理
tmpl = set()
for rel in ['src/renderer/app.js', 'src/main/main.js']:
    p = os.path.join(ROOT, rel)
    if not os.path.exists(p):
        continue
    for m in STR.finditer(open(p, encoding='utf-8').read()):
        s = (m.group(1) or m.group(2) or m.group(3) or '').strip()
        if s and CJK.search(s) and '${' in s and len(s) < 120:
            tmpl.add(s)
json.dump(sorted(tmpl), open(os.path.join(ROOT, 'src/i18n/_templates.json'), 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1)
print('待人工处理的模板:', len(tmpl))
