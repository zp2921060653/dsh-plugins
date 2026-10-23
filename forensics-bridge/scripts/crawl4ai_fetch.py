# crawl4ai 抓取脚本：URL -> markdown JSON
import asyncio
import json
import sys

# Windows 控制台/管道默认可能是 GBK，输出非 GBK 字符会 UnicodeEncodeError
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass


async def main():
    url = sys.argv[1] if len(sys.argv) > 1 else ''
    if not url:
        print(json.dumps({'ok': False, 'error': 'missing url'}))
        return
    try:
        from crawl4ai import AsyncWebCrawler
        async with AsyncWebCrawler() as crawler:
            result = await crawler.arun(url=url)
            md = getattr(result, 'markdown', None) or ''
            print(json.dumps({
                'ok': True,
                'url': url,
                'title': getattr(result, 'metadata', None).get('title') if getattr(result, 'metadata', None) else None,
                'markdown': md[:50000],
                'length': len(md),
                'error': None,
            }, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'ok': False, 'url': url, 'error': str(e)}, ensure_ascii=False))

if __name__ == '__main__':
    asyncio.run(main())
