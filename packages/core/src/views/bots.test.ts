import { describe, expect, it } from 'vitest';
import { BOT_UA_MARKERS, classifyUserAgent, isBotUserAgent } from './bots';

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0';

describe('bot detection for profile views (v2.5 phase 1)', () => {
  it('does not flag real browsers or generic HTTP clients', () => {
    for (const ua of [CHROME, SAFARI, FIREFOX, 'curl/8.7.1', 'python-requests/2.31.0', 'Wget/1.21.4']) {
      expect(isBotUserAgent(ua), ua).toBe(false);
      expect(classifyUserAgent(ua).isBot, ua).toBe(false);
    }
    expect(isBotUserAgent(null)).toBe(false);
    expect(isBotUserAgent(undefined)).toBe(false);
    expect(isBotUserAgent('')).toBe(false);
  });

  it('flags known crawlers from every vendored group', () => {
    const cases: Array<[string, string]> = [
      // [UA, expected group]
      ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'search-engine'],
      ['Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)', 'search-engine'],
      ['Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)', 'search-engine'],
      ['Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)', 'search-engine'],
      ['Mozilla/5.0 (compatible; DuckDuckBot-Https/1.1)', 'search-engine'],
      ['Mozilla/5.0 (compatible; Yahoo! Slurp)', 'search-engine'],
      ['Mozilla/5.0 (compatible; Applebot/0.1; +http://www.apple.com/go/applebot)', 'search-engine'],
      ['Twitterbot/1.0', 'social'],
      ['LinkedInBot/1.0 (compatible; Mozilla/5.0; +http://www.linkedin.com)', 'social'],
      ['facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'social'],
      ['WhatsApp/2.23.20.0', 'social'],
      ['TelegramBot (like TwitterBot)', 'social'],
      ['Discordbot/2.0 (+https://discordapp.com)', 'social'],
      ['Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', 'social'],
      ['Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)', 'ai-crawler'],
      ['Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)', 'ai-crawler'],
      ['Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)', 'ai-crawler'],
      ['Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai)', 'ai-crawler'],
      ['AhrefsBot/7.0 (+http://ahrefs.com/robot/)', 'seo'],
      ['Mozilla/5.0 (compatible; SemrushBot/7.0; +http://www.semrush.com/bot.html)', 'seo'],
      ['Mozilla/5.0 (compatible; DotBot/1.2; +https://opensiteexplorer.org/dotbot)', 'seo'],
      ['Mozilla/5.0 (compatible; archive.org_bot; +http://archive.org/details/archive.org_bot)', 'archiver'],
      ['UptimeRobot/1.0', 'monitoring'],
    ];
    for (const [ua, group] of cases) {
      const hit = classifyUserAgent(ua);
      expect(hit.isBot, ua).toBe(true);
      expect(hit.group, ua).toBe(group);
    }
  });

  it('is case-insensitive', () => {
    expect(isBotUserAgent('GOOGLEBOT/2.1')).toBe(true);
    expect(isBotUserAgent('mozilLa/5.0 ... TwiTTerBot/1.0')).toBe(true);
  });

  it('catches unknown bots through the token backstop, including glue-named ones', () => {
    expect(classifyUserAgent('ExampleBot/1.0 (+http://example.com/bot)')).toMatchObject({
      isBot: true,
      group: 'generic',
    });
    expect(isBotUserAgent('Mozilla/5.0 (compatible; ExampleCrawler/1.0)')).toBe(true);
    expect(isBotUserAgent('Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)')).toBe(true);
    expect(isBotUserAgent('ExampleSpider/1.0')).toBe(true);
    expect(isBotUserAgent('Mozilla/5.0 (bot)')).toBe(true);
    // Browser and English noise never trips the backstop.
    expect(isBotUserAgent('I fetch robots.txt for fun')).toBe(false);
    expect(isBotUserAgent('my dog ate the spiders web')).toBe(false);
    expect(isBotUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36')).toBe(false);
  });

  it('exports a documented, non-empty marker list', () => {
    expect(BOT_UA_MARKERS.length).toBeGreaterThan(30);
    for (const { marker, group } of BOT_UA_MARKERS) {
      expect(marker).toBe(marker.toLowerCase());
      expect(group.length).toBeGreaterThan(0);
    }
  });
});
