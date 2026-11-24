import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  fmtLength,
  sameVenue,
  trackDescription,
  trackPageHtml,
  trackSlug,
  venueOf,
} from "../../src/lib/trackPages";

// The pure half of the public track pages (#457).
describe("track pages", () => {
  it("slugs a catalog name", () => {
    expect(trackSlug("Virginia International Raceway (Full)")).toBe("virginia-international-raceway-full");
    expect(trackSlug("Laguna Seca (WeatherTech Raceway)")).toBe("laguna-seca-weathertech-raceway");
    expect(trackSlug("Homestead-Miami Speedway (Road Course)")).toBe("homestead-miami-speedway-road-course");
    expect(trackSlug("Thunderhill Raceway (2-Mile)")).toBe("thunderhill-raceway-2-mile");
    expect(trackSlug("  Circuit Gilles-Villeneuve & Café  ")).toBe("circuit-gilles-villeneuve-and-cafe");
  });

  it("finds a venue and its other layouts", () => {
    expect(venueOf("New Jersey Motorsports Park (Lightning)")).toBe("New Jersey Motorsports Park");
    expect(venueOf("Road America")).toBe("Road America");
    const rows = [
      { id: 1, name: "New Jersey Motorsports Park (Lightning)" },
      { id: 2, name: "New Jersey Motorsports Park (Thunderbolt)" },
      { id: 3, name: "Road America" },
    ];
    expect(sameVenue(rows, rows[0]).map((r) => r.id)).toEqual([2]);
    expect(sameVenue(rows, rows[2])).toEqual([]);
  });

  it("formats a length in both systems, or not at all", () => {
    expect(fmtLength(5263)).toBe("3.27 mi (5.26 km)");
    expect(fmtLength(null)).toBeNull();
    expect(fmtLength(0)).toBeNull();
  });

  it("describes a track with and without laps", () => {
    const t = { id: 1, name: "Road America", length_m: 6500, lat: 43.8, lon: -87.99 };
    expect(trackDescription(t, { drivers: 3, best_ms: [142110] })).toBe(
      "Lap times at Road America: the fastest GPS-timed lap logged by Track Evolution drivers is 2:22.11, from 3 drivers. The lap is 4.04 mi (6.50 km)."
    );
    expect(trackDescription({ ...t, length_m: null }, { drivers: 0, best_ms: [] })).toMatch(
      /^Lap times at Road America\. Time your own laps/
    );
  });

  it("escapes a name into the page and its structured data", () => {
    const t = { id: 1, name: `Evil </script><b> "Ring"`, length_m: null, lat: null, lon: null };
    const html = trackPageHtml(t, { drivers: 0, best_ms: [] }, [t]);
    expect(html).not.toContain("</script><b>");
    expect(html).toContain("Evil &lt;/script&gt;&lt;b&gt; &quot;Ring&quot; lap times");
  });

  it("is reachable: worker-first, skipped by the service worker, named in robots.txt", () => {
    const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
    expect(read("wrangler.jsonc")).toContain('"/tracks/*"');
    expect(read("public/sw.js")).toContain('url.pathname.startsWith("/tracks/")');
    expect(read("public/robots.txt")).toContain("Sitemap: https://trackevolution.app/tracks/sitemap.xml");
  });
});
