import { describe, expect, it } from "vitest";
import { APP_STORE_URL, PLAY_STORE_URL, storeFor, storeUrl } from "../../src/lib/storeLinks";

const UA = {
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  ipadOld:
    "Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1",
  instagramIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0",
  pixel:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  androidTablet:
    "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  facebook: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
};

describe("storeFor", () => {
  it("sends iPhones, iPods and pre-13 iPads to the App Store", () => {
    for (const ua of [UA.iphone, UA.ipadOld, UA.instagramIos]) expect(storeFor(ua), ua).toBe("ios");
  });

  it("sends Android phones and tablets to Play", () => {
    for (const ua of [UA.pixel, UA.androidTablet]) expect(storeFor(ua), ua).toBe("android");
  });

  it("offers both to desktops, scrapers and a missing header", () => {
    // A modern iPad reads as the Mac here; the page's script handles it.
    for (const ua of [UA.mac, UA.windows, UA.facebook, "", null, undefined]) expect(storeFor(ua)).toBeNull();
  });
});

describe("storeUrl", () => {
  it("maps each platform to its listing", () => {
    expect(storeUrl("ios")).toBe(APP_STORE_URL);
    expect(storeUrl("android")).toBe(PLAY_STORE_URL);
  });
});
