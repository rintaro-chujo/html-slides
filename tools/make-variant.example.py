#!/usr/bin/env python3
"""
make-variant.py（例）— index.html の一部のスライドだけを差し替えた別版 index-<variant>.html を生成する。

使いどころ
  同じ発表で「どこまで具体を見せるか」などの判断が割れたとき、差し替え版を作って見比べる。
  共通部分は index.html だけを編集し、このスクリプトを再実行すれば別版も追従する。
  片方に決めたら中身を index.html に移して1本に戻し、このスクリプトと別版は片付ける。

  python3 make-variant.py   （発表フォルダ直下に置く。箱の tools/ ではなくデッキ固有のスクリプト）

鉄則：非貪欲マッチ <section.*?見出し.*?</section> で置換しない（前のスライドまで飲み込む）。
      全 section を列挙し、見出しを含むものを1つ選んで start()/end() で切る。
"""
import os
import re
import sys

DECK = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(DECK, "index.html")
DST = os.path.join(DECK, "index-abstract.html")

SECTION_RE = re.compile(r'<section class="slide[^"]*"[^>]*>.*?</section>\n', re.S)


def sections(src):
    return list(SECTION_RE.finditer(src))


def find(src, needle):
    hits = [m for m in sections(src) if needle in m.group(0)]
    if len(hits) != 1:
        sys.exit("見出しに一致するスライドが %d 枚あります: %s" % (len(hits), needle))
    return hits[0]


def replace_section(src, needle, new):
    m = find(src, needle)
    return src[: m.start()] + new + src[m.end():]


def insert_after(src, needle, new):
    m = find(src, needle)
    return src[: m.end()] + new + src[m.end():]


# ---------------------------------------------------------------- 差し替えるスライド
PROPOSAL = '''<section class="slide" data-min="0.4">
  <h2>提案：行動の記録から通知時刻を決める</h2>
  <div class="body">
    <p>その人が<span class="r">開きやすい時間帯</span>の直前に通知する</p>
  </div>
  <aside class="notes">
    <p>抽象版では、仕組みの図を本編から外し、考え方だけを述べる。</p>
  </aside>
</section>
'''

APPENDIX = '''<section class="slide" data-backup="1">
  <h2>予備：実装の詳細</h2>
  <div class="body">
    <div class="figure">%s</div>
  </div>
  <aside class="notes"><p>本編から外した図は予備スライドに移して残す。</p></aside>
</section>
'''


def main():
    src = open(SRC, encoding="utf-8").read()

    # 本編の図は予備スライドで再利用する
    old = find(src, "<h2>提案：行動の記録から通知時刻を決める</h2>").group(0)
    svg = old[old.index("<svg"): old.index("</svg>") + 6] if "<svg" in old else ""

    out = replace_section(src, "<h2>提案：行動の記録から通知時刻を決める</h2>", PROPOSAL)
    out = insert_after(out, '<p class="st">予備スライド</p>', "\n" + APPENDIX % svg)

    banner = ("<!-- 自動生成ファイル: make-variant.py が index.html から作っています。\n"
              "     直接編集しないでください（次の生成で消えます）。\n"
              "     共通部分は index.html を、差し替え部分は make-variant.py を編集し、\n"
              "     python3 make-variant.py を実行してください。 -->\n")
    out = banner + out
    open(DST, "w", encoding="utf-8").write(out)
    print("%s -> %s（%d枚 -> %d枚）" % (os.path.basename(SRC), os.path.basename(DST),
                                      len(sections(src)), len(sections(out))))


if __name__ == "__main__":
    main()
