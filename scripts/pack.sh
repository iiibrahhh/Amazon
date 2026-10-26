#!/usr/bin/env bash
# يبني ZIP جاهزًا للتثبيت (مجلد الإضافة فقط) وZIP كاملًا للمشروع.
set -e
cd "$(dirname "$0")/.."
mkdir -p dist
rm -f dist/*.zip
(cd extension && zip -qr ../dist/amazon-sa-intl-finder-extension.zip . -x '*.DS_Store')
zip -qr dist/amazon-sa-intl-finder-full-project.zip extension tests docs scripts README.md config.sample.json package.json -x '*/node_modules/*' '*.DS_Store'
ls -la dist
