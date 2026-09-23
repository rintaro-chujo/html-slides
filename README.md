# html-slides

HTML で書くスライドのための道具一式。1枚が `<section class="slide">`（1920×1080）の `index.html` を書けば、
本番表示・発表者ビュー（ノート・タイマー・次スライド）・タブ間の同期・印刷用表示が使えます。

- **ビューア**：https://rintaro-chujo.github.io/html-slides/
  発表フォルダ（`index.html` と `assets/`）を選ぶだけで、ブラウザ上で発表・編集・PDF 化ができます。
  Chrome / Edge では、発表者ビューで直したノートや本文がそのフォルダの `index.html` に保存されます。ファイルはどこにも送りません。
- **見本**：https://rintaro-chujo.github.io/html-slides/demo/index.html?mode=notes

```
deck/deck.css                  設計システム（文字サイズ5種・余白トークン・発表者ビュー）
deck/deck.js                   エンジン（モード・タブ同期・発表者ビュー・ノート/本文編集・グラフ）
site/                          ビューア（GitHub Pages に置くページ）
templates/index.template.html  中身ファイルの雛形（<!--TITLE--> <!--NAME--> <!--SLIDES--> を埋める）
templates/snippets.html        スライド部品の例（タイトル・図・グラフ・表など。中身は架空）
tools/serve.py                 手元で開くサーバ（編集の書き戻し・オフライン発表）
tools/export.py                PDF / ノート付き PDF / PNG / PowerPoint 書き出し
tools/build-site.py            Pages 用サイトの組み立てと公開（--publish で gh-pages へ）
tools/make-variant.example.py  一部のスライドを差し替えた別版を作るスクリプトの例
```

## スライドを作る

雛形をコピーし、`<!--TITLE-->`・`<!--NAME-->`・`<!--SLIDES-->` を埋めます。スライドの部品は `templates/snippets.html` を参考にしてください。

```html
<link rel="stylesheet" href="https://rintaro-chujo.github.io/html-slides/v1/deck/deck.css">
<div id="deck">
  <section class="slide" data-min="0.5">
    <h2>見出し</h2>
    <div class="body"><p>本文。<span class="r">強調</span>は赤</p></div>
    <aside class="notes"><p>発表者ノート</p></aside>
  </section>
</div>
<script src="https://rintaro-chujo.github.io/html-slides/v1/deck/deck.js"></script>
```

- `v1` は 1.x の最新版を指します。見た目を固定したいときは `v1.0.0` のように版まで書きます。
- 画像などは発表フォルダの `assets/` に置き、相対パスで参照します。
- `data-min` は予定の分数、`data-backup="1"` は予備スライド、`class="fragment"` は1つずつ出す要素です。

発表フォルダの形：

```
<talk>/
  index.html     中身だけ（CSS/JS は書かない。発表固有の上書きだけ <style> に）
  assets/        ロゴ・スクショ・写真
  dist/          書き出し（.gitignore）
```

## 開く

**ブラウザだけで**：[ビューア](https://rintaro-chujo.github.io/html-slides/)で発表フォルダを選び、「発表者ビュー／本番／PDF／ノート付き PDF」を選びます。
スライドは新しいタブで開き、ファイルはビューアのタブが渡しているので、発表中もビューアのタブは開いたままにします。
PDF は印刷画面で「PDF に保存」を選び、余白「なし」・背景のグラフィック「オン」にします。

**手元で**（書き戻し・オフライン発表・PNG / PowerPoint 書き出し）：このリポジトリを取得して、発表フォルダで実行します。

```bash
git clone https://github.com/rintaro-chujo/html-slides.git ~/html-slides
cd <talk>
python3 ~/html-slides/tools/serve.py          # 今いるフォルダを配信。引数でファイル／フォルダも指定可
```

一覧ページ（http://127.0.0.1:8765/ ）から開きます。`--no-open` でブラウザを開かない、`--port` でポート。
`index.html` が公開版の `v1/deck/` を読んでいても、serve.py は手元の `deck/` に差し替えて配信するので、ネットにつながらない会場でも発表できます。
発表フォルダに `deck/` があればそちらを優先します。

| 用途 | URL |
|---|---|
| 本番（全画面） | `index.html?mode=present` |
| 発表者ビュー（ノート・タイマー・次スライド） | `index.html?mode=notes` |
| 印刷用 | `index.html?mode=print`（`&notes=1` でノート付き） |

キー：→ / Space 次、← 前、F 全画面、S 発表者ビュー、O 一覧、H つかみ案切替、数字+Enter ジャンプ、? ヘルプ。
発表者ビューで編集したノート・本文は、最初の書き込みの前に `dist/*.bak-*` にバックアップを取ってから保存します。

## 書き出す

前提：Google Chrome、poppler（`brew install poppler`）、`pip install python-pptx pillow`、Python 3.9 以上。

```bash
cd <talk>
python3 ~/html-slides/tools/export.py all          # dist/<name>.pdf / <name>-notes.pdf / png/ / <name>.pptx
python3 ~/html-slides/tools/export.py pdf --notes  # 個別にも出せる：pdf / png / pptx
```

`<name>` は `index.html` の `<meta name="deck-export-name" content="…">`（無ければフォルダ名、`--name` で上書き）。
別版 `index-abstract.html` は `--html index-abstract.html` で書き出し、出力名に `-abstract` が付きます。

| オプション | 意味 |
|---|---|
| `--hook A\|B\|C\|all` | 表示するつかみ案（既定 A） |
| `--out PATH` | `pdf` / `pptx` の出力先 |
| `--dpi N` | `png` の解像度（既定 96 → 1920×1080） |
| `--reuse-pdf` | `png` / `pptx` で既存の dist PDF を再印刷せずに使う |
| `--html PATH`, `--name NAME` | 対象 HTML（既定 `./index.html`）、出力名 |
| `--chrome PATH`, `--timeout SEC`, `--tmpdir DIR` | Chrome の場所（既定は macOS の場所。`$CHROME` でも可）、1回の上限秒数、一時プロファイル置き場 |

export.py は serve.py のサーバを空きポートで裏に立て、headless Chrome に `?mode=print` を印刷させます。
ページ数とサイズ（1440×810 pt）を検証し、末尾の白紙ページは自動で削ります。PowerPoint は各ページを画像で貼り、ノートを付けます。

## 版と公開

- `deck/` を変えたら動作確認してコミットし、`VERSION` を上げてタグを付けます（`git tag v1.1.0 && git push --tags`）。
  見た目が変わる変更や互換性のない変更はメジャー版を上げます（`v2`）。
- 公開は `python3 tools/build-site.py --publish`：タグから組み立てたサイトを `gh-pages` ブランチにコミットして push します（Pages は gh-pages から配信）。
  タグごとに `vX.Y.Z/deck/`、メジャー版ごとに最新タグを `vN/deck/` として公開します。
- 手元でサイトを確かめるには `python3 tools/build-site.py --dev`（作業中の `deck/` も入れる）。出力は `_site/`。

## ライセンス

MIT
