import { load } from 'cheerio';
import pMap from 'p-map';

import type { DataItem, Route } from '@/types';
import cache from '@/utils/cache';
import ofetch from '@/utils/ofetch';
import { parseDate } from '@/utils/parse-date';

const baseUrl = 'https://claude.com';
const articlesUrl = `${baseUrl}/resources/articles`;

export const route: Route = {
    path: '/blog',
    categories: ['programming'],
    example: '/claude/blog',
    parameters: {},
    features: {
        requireConfig: false,
        requirePuppeteer: false,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    radar: [
        {
            source: ['claude.com/resources/articles', 'claude.com/blog'],
            target: '/blog',
        },
    ],
    name: 'Blog',
    maintainers: ['zhenlohuang'],
    handler,
    url: 'claude.com/resources/articles',
};

async function handler(ctx) {
    const response = await ofetch(articlesUrl);
    const $ = load(response);
    const flightPushRegex = /self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)/g;
    let flightData = '';

    for (const script of $('script').toArray()) {
        for (const match of $(script).text().matchAll(flightPushRegex)) {
            flightData += JSON.parse(match[1]);
        }
    }

    const scopeIndex = flightData.indexOf('"scope":{"kind":"type","value":"article"');
    if (scopeIndex === -1) {
        throw new Error('Claude articles flight data does not contain the article scope');
    }

    const objectStart = flightData.lastIndexOf('{', scopeIndex);
    let objectEnd = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = objectStart; index < flightData.length; index++) {
        const character = flightData[index];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (character === '\\') {
                escaped = true;
            } else if (character === '"') {
                inString = false;
            }
        } else if (character === '"') {
            inString = true;
        } else if (character === '{') {
            depth++;
        } else if (character === '}') {
            depth--;
            if (depth === 0) {
                objectEnd = index + 1;
                break;
            }
        }
    }

    if (objectEnd === -1) {
        throw new Error('Claude articles flight data contains an unterminated article scope object');
    }

    const articleData = JSON.parse(flightData.slice(objectStart, objectEnd));
    const articleList = articleData.curated;
    if (articleData.scope.kind !== 'type' || articleData.scope.value !== 'article' || !Array.isArray(articleList?.items) || articleList.items.length === 0 || typeof articleList.total !== 'number') {
        throw new Error('Claude articles flight data does not contain a non-empty article list');
    }

    const limit = ctx.req.query('limit') ? Number(ctx.req.query('limit')) : 20;
    const posts: DataItem[] = articleList.items.slice(0, limit).map((post) => {
        if (!post.externalUrl && !post.slug) {
            throw new Error(`Claude article "${post.title}" has neither a slug nor an external URL`);
        }

        const category = [...new Set([post.category?.name, ...(post.products ?? []).map((product) => product.name)].filter(Boolean))];
        const item: DataItem = {
            title: post.title,
            link: post.externalUrl ?? `${articlesUrl}/${post.slug}`,
            pubDate: parseDate(post.date),
            category,
        };

        if (!post.slug && post.externalUrl && typeof post.excerpt === 'string') {
            item.description = post.excerpt;
        }

        return item;
    });

    const items = await pMap(
        posts,
        (item) => {
            if (item.link?.startsWith(`${articlesUrl}/`) !== true) {
                return item;
            }

            return cache.tryGet(item.link, async () => {
                const response = await ofetch(item.link!);
                const $ = load(response);
                const content = $('.text-rich-text--article');
                if (content.length === 0) {
                    throw new Error(`Claude article page ${item.link} does not contain its article body`);
                }

                content.find('svg, button, script, style').remove();
                item.description = content.html();

                const blogPosting = $('script[type="application/ld+json"]')
                    .toArray()
                    .map((script) => JSON.parse($(script).text()))
                    .find((data) => data['@type'] === 'BlogPosting');
                if (blogPosting?.author) {
                    item.author = blogPosting.author.map((author) => ({ name: author.name }));
                }
                if (blogPosting?.datePublished) {
                    item.pubDate = parseDate(blogPosting.datePublished);
                }

                return item;
            });
        },
        { concurrency: 3 }
    );

    return {
        title: 'Claude Blog',
        link: articlesUrl,
        description: 'Product news and best practices for teams building with Claude.',
        language: 'en' as const,
        item: items,
    };
}
