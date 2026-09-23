#!/usr/bin/env python3
"""
build-site.py — GitHub Pages に置くサイト（_site/）を組み立てる。

  python3 tools/build-site.py            # タグ（vX.Y.Z）から _site/ に組み立てる
  python3 tools/build-site.py --dev      # 作業中の deck/ も VERSION の版として入れる（手元の確認用）
  python3 tools/build-site.py --publish  # タグから組み立てて gh-pages ブランチにコミット・push（= 公開）
  python3 tools/build-site.py --out DIR  # 出力先（既定 _site/）

出来上がるもの
  index.html, viewer.js, sw.js   ビューア（フォルダを開いて表示・編集・PDF）
  vX.Y.Z/deck/deck.{css,js}      タグごとの deck（固定版）
  vN/deck/deck.{css,js}          メジャー版 N の最新タグ（index.html からはふつうこれを読む）
  templates/                     雛形・部品例・見本の画像
  demo/                          雛形＋部品例から作る見本スライド
"""
import argparse
import os
import re
import shutil
import subprocess
import sys

BOX = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = "https://rintaro-chujo.github.io/html-slides/"
DECK_FILES = ("deck.css", "deck.js")


def git(*args):
    return subprocess.run(["git", "-C", BOX] + list(args), check=True, capture_output=True).stdout


def semver(tag):
    m = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", tag)
    return tuple(int(x) for x in m.groups()) if m else None


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def publish(out):
    """組み立てたサイトを gh-pages ブランチの新しいコミットとして push する（force はしない）。"""
    import tempfile
    remote = git("remote", "get-url", "origin").decode().strip()
    head = git("rev-parse", "--short", "HEAD").decode().strip()
    name, email = (git("config", k).decode().strip() for k in ("user.name", "user.email"))
    work = tempfile.mkdtemp(prefix="gh-pages-")
    run = lambda *c: subprocess.run(["git", "-C", work, "-c", "user.name=" + name, "-c", "user.email=" + email] + list(c), check=True)
    exists = subprocess.run(["git", "ls-remote", "--exit-code", "--heads", remote, "gh-pages"], capture_output=True).returncode == 0
    if exists:
        subprocess.run(["git", "clone", "-q", "--depth", "1", "--branch", "gh-pages", remote, work], check=True)
        for n in os.listdir(work):
            if n != ".git":
                p = os.path.join(work, n)
                shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
    else:
        run("init", "-q", "-b", "gh-pages")
        run("remote", "add", "origin", remote)
    shutil.copytree(out, work, dirs_exist_ok=True)
    run("add", "-A")
    if subprocess.run(["git", "-C", work, "diff", "--cached", "--quiet"]).returncode == 0:
        print("[site] 変更なし（gh-pages は最新）")
    else:
        run("commit", "-q", "-m", "site from %s" % head)
        run("push", "-q", "origin", "gh-pages")
        print("[site] gh-pages に公開しました（%s）" % PUBLIC)
    shutil.rmtree(work, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=os.path.join(BOX, "_site"))
    ap.add_argument("--dev", action="store_true")
    ap.add_argument("--publish", action="store_true")
    a = ap.parse_args()
    if a.publish and a.dev:
        sys.exit("--publish は --dev と一緒に使えません（公開はタグの版だけ）")

    # 版ごとの deck の中身：{(major, minor, patch): {name: bytes}}
    versions = {}
    for tag in git("tag", "-l", "v*").decode().split():
        v = semver(tag)
        if not v:
            continue
        try:
            versions[v] = {n: git("show", "%s:deck/%s" % (tag, n)) for n in DECK_FILES}
        except subprocess.CalledProcessError:
            print("[site] skip %s（deck/ がない）" % tag)
    if a.dev:
        cur = semver("v" + open(os.path.join(BOX, "VERSION")).read().strip())
        versions[cur] = {n: open(os.path.join(BOX, "deck", n), "rb").read() for n in DECK_FILES}
    if not versions:
        sys.exit("vX.Y.Z のタグがありません（手元の確認なら --dev）")

    out = a.out
    if os.path.isdir(out):
        shutil.rmtree(out)
    os.makedirs(out)

    latest = {}
    for v, files in sorted(versions.items()):
        for n, data in files.items():
            write(os.path.join(out, "v%d.%d.%d" % v, "deck", n), data)
        latest[v[0]] = files
    for major, files in latest.items():
        for n, data in files.items():
            write(os.path.join(out, "v%d" % major, "deck", n), data)
    newest_major = max(latest)

    # ビューア
    for n in ("index.html", "viewer.js"):
        shutil.copy2(os.path.join(BOX, "site", n), os.path.join(out, n))
    sw = open(os.path.join(BOX, "site", "sw.js"), encoding="utf-8").read()
    sw = sw.replace("const DEFAULT_DECK = 'v1';", "const DEFAULT_DECK = 'v%d';" % newest_major)
    write(os.path.join(out, "sw.js"), sw.encode("utf-8"))

    # 雛形と見本
    shutil.copytree(os.path.join(BOX, "templates"), os.path.join(out, "templates"))
    tpl = open(os.path.join(BOX, "templates", "index.template.html"), encoding="utf-8").read()
    snippets = open(os.path.join(BOX, "templates", "snippets.html"), encoding="utf-8").read()
    demo = (tpl.replace("<!--TITLE-->", "html-slides 見本")
               .replace("<!--NAME-->", "html-slides-demo")
               .replace("<!--SLIDES-->", snippets)
               .replace(PUBLIC + "v%d/deck/" % newest_major, "../v%d/deck/" % newest_major))
    write(os.path.join(out, "demo", "index.html"), demo.encode("utf-8"))
    shutil.copytree(os.path.join(BOX, "templates", "assets"), os.path.join(out, "demo", "assets"))

    write(os.path.join(out, ".nojekyll"), b"")
    if a.publish:
        publish(out)
    print("[site] %s: %s（v%d = v%d.%d.%d）" % (
        os.path.relpath(out, BOX), ", ".join("v%d.%d.%d" % v for v in sorted(versions)),
        newest_major, *max(v for v in versions if v[0] == newest_major)))


if __name__ == "__main__":
    main()
