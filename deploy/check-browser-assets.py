#!/usr/bin/env python3
"""Check complete HTML and entry assets through the public reverse proxy."""

import argparse
from html.parser import HTMLParser
import sys
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen


class Assets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = {}
        self.has_module = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "script" and attrs.get("src"):
            self.urls[attrs["src"]] = "javascript"
            self.has_module |= attrs.get("type") == "module"
        if tag == "link" and attrs.get("href"):
            rel = attrs.get("rel", "").split()
            if "modulepreload" in rel:
                self.urls[attrs["href"]] = "javascript"
            elif "stylesheet" in rel:
                self.urls[attrs["href"]] = "css"


def fetch(url, kind):
    request = Request(url, headers={"Accept-Encoding": "identity", "Cache-Control": "no-cache"})
    with urlopen(request, timeout=30) as response:
        body = response.read()  # Raises IncompleteRead for a truncated Content-Length.
        mime = response.headers.get_content_type()
        allowed = {
            "html": {"text/html"},
            "javascript": {"text/javascript", "application/javascript"},
            "css": {"text/css"},
        }
        if response.status != 200 or mime not in allowed[kind] or not body:
            raise ValueError(f"Unexpected response for {url}: {response.status}, {mime}, {len(body)} bytes")
        length = response.headers.get("Content-Length")
        if length is not None and len(body) != int(length):
            raise ValueError(f"Incomplete response for {url}: {len(body)}/{length} bytes")
        print(f"OK {len(body):>9} bytes {url}")
        return body


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("origin", nargs="?", default="https://terminal.fyxtez.com")
    args = parser.parse_args()
    origin = args.origin.rstrip("/") + "/"
    checked = set()
    for route in ("", "BTC"):
        page_url = urljoin(origin, route)
        assets = Assets()
        assets.feed(fetch(page_url, "html").decode("utf-8"))
        if not assets.has_module:
            raise ValueError(f"Missing application module in {page_url}")
        for path, kind in assets.urls.items():
            url = urljoin(page_url, path)
            if urlsplit(url)[:2] != urlsplit(origin)[:2]:
                raise ValueError(f"Unexpected external asset: {url}")
            if url not in checked:
                fetch(url, kind)
                checked.add(url)
    print(f"PASS: both browser routes and {len(checked)} entry assets downloaded completely.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
