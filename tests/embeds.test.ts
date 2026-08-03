import { describe, expect, test } from "vitest";
import { isEmbeddable, toEmbed } from "../src/lib/embeds";

const src = (url: string) => toEmbed(url)?.src;

describe("YouTube", () => {
  test("watch, short, shorts and embed URLs all resolve to the player", () => {
    const expected = "https://www.youtube.com/embed/dQw4w9WgXcQ";
    expect(src("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(expected);
    expect(src("https://youtu.be/dQw4w9WgXcQ")).toBe(expected);
    expect(src("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe(expected);
    expect(src("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe(expected);
    expect(src("youtube.com/watch?v=dQw4w9WgXcQ")).toBe(expected); // no scheme
  });

  test("keeps a start offset, in both seconds and 1m30s form", () => {
    expect(src("https://youtu.be/abc123?t=90")).toBe(
      "https://www.youtube.com/embed/abc123?start=90",
    );
    expect(src("https://www.youtube.com/watch?v=abc123&t=1m30s")).toBe(
      "https://www.youtube.com/embed/abc123?start=90",
    );
  });

  test("is 16:9 and fullscreen-capable", () => {
    const info = toEmbed("https://youtu.be/abc123")!;
    expect(info.aspect).toBeCloseTo(16 / 9);
    expect(info.allowFullscreen).toBe(true);
    expect(info.provider).toBe("YouTube");
  });
});

test("Vimeo share and player URLs resolve to the player", () => {
  expect(src("https://vimeo.com/123456789")).toBe(
    "https://player.vimeo.com/video/123456789",
  );
  expect(src("https://player.vimeo.com/video/123456789")).toBe(
    "https://player.vimeo.com/video/123456789",
  );
});

test("Loom share URL becomes an embed URL", () => {
  expect(src("https://www.loom.com/share/abc123def456")).toBe(
    "https://www.loom.com/embed/abc123def456",
  );
});

test("Spotify keeps its media type and gets a compact aspect for tracks", () => {
  expect(src("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT")).toBe(
    "https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT",
  );
  expect(toEmbed("https://open.spotify.com/track/x")!.aspect).toBe(5);
  expect(toEmbed("https://open.spotify.com/album/x")!.aspect).toBe(1.4);
});

test("Figma wraps the original URL in the embed host", () => {
  const info = toEmbed("https://www.figma.com/design/abc/My-File")!;
  expect(info.provider).toBe("Figma");
  expect(info.src).toContain("figma.com/embed?embed_host=vellum&url=");
  expect(info.src).toContain(encodeURIComponent("figma.com/design/abc/My-File"));
});

test("CodePen pen URL becomes an embed URL", () => {
  expect(src("https://codepen.io/someone/pen/abcXYZ")).toBe(
    "https://codepen.io/someone/embed/abcXYZ",
  );
});

test("Google Docs links become /preview", () => {
  expect(src("https://docs.google.com/document/d/abc123/edit?usp=sharing")).toBe(
    "https://docs.google.com/document/d/abc123/preview",
  );
});

describe("Google Maps", () => {
  test("coordinates win over the place name", () => {
    expect(src("https://www.google.com/maps/place/Eiffel+Tower/@48.8584,2.2945,17z")).toBe(
      "https://maps.google.com/maps?q=48.8584%2C2.2945&output=embed",
    );
  });

  test("falls back to the place name when there are no coordinates", () => {
    expect(src("https://www.google.com/maps/place/Eiffel+Tower")).toBe(
      "https://maps.google.com/maps?q=Eiffel%20Tower&output=embed",
    );
  });

  test("an already-embeddable maps URL is passed through untouched", () => {
    const embed = "https://www.google.com/maps/embed?pb=!1m18!2m3";
    expect(src(embed)).toBe(embed);
  });
});

test("unknown sites still embed, labelled by hostname", () => {
  const info = toEmbed("https://example.com/some/page")!;
  expect(info.src).toBe("https://example.com/some/page");
  expect(info.provider).toBe("example.com");
});

describe("rejects what must never reach an iframe", () => {
  test.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["file:", "file:///etc/passwd"],
    ["bare word", "notaurl"],
  ])("%s", (_label, input) => {
    expect(toEmbed(input)).toBeNull();
    expect(isEmbeddable(input)).toBe(false);
  });
});
