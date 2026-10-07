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
            source: ['claude.com/resources/articles'],
            target: '/blog',
        },
    ],
    name: 'Blog',
    maintainers: ['zhenlohuang', 'zj1123581321'],
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

    let articleData:
        | {
              curated: {
                  items: Array<{
                      title: string;
                      slug: string | null;
                      externalUrl: string | null;
                      date: string;
                      category?: { name?: string } | null;
                      products?: Array<{ name: string }> | null;
                      excerpt: string | null;
                  }>;
              };
          }
        | undefined;
    const partRegex = /^[0-9a-z]+:[0-9a-z]*(\[.*)$/i;
    for (const line of flightData.split('\n')) {
        const match = partRegex.exec(line);
        if (match && line.includes('"scope":{"kind":"type","value":"article"')) {
            JSON.parse(match[1], (key, value) => {
                if (value?.scope?.kind === 'type' && value.scope.value === 'article') {
                    articleData = value as NonNullable<typeof articleData>;
                }
                return value;
            });
        }
    }

    const articleList = articleData!.curated;
    const limit = ctx.req.query('limit') ? Number(ctx.req.query('limit')) : 15;
    const items = await pMap(
        articleList.items.slice(0, limit),
        (post) => {
            const category = [...new Set([post.category?.name, ...(post.products ?? []).map((product) => product.name)].filter((name): name is string => Boolean(name)))];
            const item: DataItem = {
                title: post.title,
                link: post.externalUrl ?? `${articlesUrl}/${post.slug}`,
                pubDate: parseDate(post.date),
                category,
            };

            if (post.slug) {
                return cache.tryGet(item.link!, async () => {
                    const response = await ofetch(item.link!);
                    const $ = load(response);
                    const content = $('.text-rich-text--article');
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
            }

            if (post.excerpt !== null) {
                item.description = post.excerpt;
            }
            return item;
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
