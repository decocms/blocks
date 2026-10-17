import { describe, expect, it } from "vitest";
import * as v7 from "./__fixtures__/v7/sdk/detectDevice";
import { pick, rng } from "./__tests__/v7";
import { detectDevice, isMobileUA, MOBILE_RE, TABLET_RE } from "./device";

const REAL_UAS = [
  "",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPod touch; CPU iPhone OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; U; Android 4.0.3; en-us; KFTT Build/IML74K) AppleWebKit/537.36 (KHTML, like Gecko) Silk/3.68 like Chrome/39.0.2171.93 Safari/537.36",
  "Mozilla/5.0 (X11; U; Linux armv7l like Android; en-us) AppleWebKit/531.2+ (KHTML, like Gecko) Version/5.0 Safari/533.2+ Kindle/3.0+",
  "Mozilla/5.0 (PlayBook; U; RIM Tablet OS 2.1.0; en-US) AppleWebKit/536.2+ (KHTML like Gecko) Version/7.2.1.0 Safari/536.2+",
  "Mozilla/5.0 (BlackBerry; U; BlackBerry 9900; en) AppleWebKit/534.11+ (KHTML, like Gecko) Version/7.1.0.346 Mobile Safari/534.11+",
  "Opera/9.80 (J2ME/MIDP; Opera Mini/9.80 (S60; SymbOS; Opera Mobi/23.348; U; en) Presto/2.5.25 Version/10.54",
  "Mozilla/5.0 (compatible; MSIE 10.0; Windows Phone 8.0; Trident/6.0; IEMobile/10.0; ARM; Touch; NOKIA; Lumia 920)",
  "Mozilla/5.0 (webOS/1.4.0; U; en-US) AppleWebKit/532.2 (KHTML, like Gecko) Version/1.0 Safari/532.2 Pre/1.0",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 (Linux; Android 11; Lenovo TB-J606F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Linux; Android 12; SAMSUNG SM-T870) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/22.0 Chrome/111.0.5563.116 Safari/537.36",
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "curl/8.5.0",
  "Lighthouse",
];

// Fragments of the patterns and their near misses, in random case.
const TOKENS = [
  "mobile",
  "Mobile",
  "android",
  "Android",
  "iphone",
  "ipod",
  "ipad",
  "webos",
  "blackberry",
  "opera mini",
  "opera  mini",
  "iemobile",
  "tablet",
  "kindle",
  "silk",
  "playbook",
  "android mobile",
  "androidmobile",
  "Mobi",
  "Tab",
  "Windows",
  "Macintosh",
  "Linux",
  "Chrome/129",
  "Safari",
  " ",
  ";",
  "(",
  ")",
  "/",
  "\n",
  "\t",
  "ÄNDROID",
  "ı",
  "mobİle",
  "a",
  "m",
];

function randomUA(r: () => number): string {
  let out = "";
  const n = Math.floor(r() * 8);
  for (let i = 0; i < n; i++) {
    const token = pick(r, TOKENS);
    out += [...token].map((c) => (r() < 0.3 ? c.toUpperCase() : c)).join("");
    if (r() < 0.5) out += pick(r, [" ", "; ", "/", ""]);
  }
  return out;
}

describe("device detection is v7's", () => {
  it("has v7's patterns", () => {
    expect(MOBILE_RE.source).toBe(v7.MOBILE_RE.source);
    expect(MOBILE_RE.flags).toBe(v7.MOBILE_RE.flags);
    expect(TABLET_RE.source).toBe(v7.TABLET_RE.source);
    expect(TABLET_RE.flags).toBe(v7.TABLET_RE.flags);
  });

  it("splits real user agents as v7 did", () => {
    const got = REAL_UAS.map((ua) => [detectDevice(ua), isMobileUA(ua)]);
    expect(got).toEqual(REAL_UAS.map((ua) => [v7.detectDevice(ua), v7.isMobileUA(ua)]));
    expect(detectDevice(REAL_UAS[5])).toBe("mobile");
    expect(detectDevice(REAL_UAS[6])).toBe("tablet");
    expect(detectDevice(REAL_UAS[1])).toBe("desktop");
    expect(detectDevice(REAL_UAS[9])).toBe("tablet");
  });

  it("agrees with v7 on 50,000 generated user agents", () => {
    const r = rng(0x7d3c);
    const seen = new Set<string>();
    for (let i = 0; i < 50_000; i++) {
      const ua = randomUA(r);
      const ours = [detectDevice(ua), isMobileUA(ua)];
      const theirs = [v7.detectDevice(ua), v7.isMobileUA(ua)];
      if (ours[0] !== theirs[0] || ours[1] !== theirs[1]) expect([ua, ours]).toEqual([ua, theirs]);
      seen.add(String(ours[0]));
    }
    expect([...seen].sort()).toEqual(["desktop", "mobile", "tablet"]);
  });
});
