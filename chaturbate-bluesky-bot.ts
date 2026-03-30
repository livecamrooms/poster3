/**
 * Chaturbate → Bluesky Autopost Bot
 *
 * Posts affiliate revshare links to Bluesky for live cam rooms in specific tags.
 * Each post includes the room preview image, a "Watch Now" hyperlink, and the
 * room's own hashtags.
 *
 * Required env vars:
 *   BSKY_HANDLE       – your Bluesky handle, e.g. cam-whores.bsky.social
 *   BSKY_APP_PASSWORD – an App Password created in Bluesky settings
 *   CB_TAGS           – comma-separated Chaturbate tags, e.g. "bigass,latina,milf"
 *
 * Optional env vars:
 *   CB_WM             – your Chaturbate affiliate wm code (default: T2CSW)
 *   CB_MIN_VIEWERS    – minimum viewers to include a room (default: 30)
 *   POST_COUNT        – number of posts this run (default: 1)
 *   DELAY_BETWEEN_MS  – ms to wait between posts when POST_COUNT > 1 (default: random 5-15 min)
 */

import { BskyAgent, RichText } from "@atproto/api";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BSKY_HANDLE = process.env.BSKY_HANDLE ?? "";
const BSKY_APP_PASSWORD = process.env.BSKY_APP_PASSWORD ?? "";
const CB_WM = process.env.CB_WM ?? "T2CSW";
const CB_TAGS = (process.env.CB_TAGS ?? "bigass,latina,milf,teen,lovense")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const CB_MIN_VIEWERS = parseInt(process.env.CB_MIN_VIEWERS ?? "30", 10);
const POST_COUNT = parseInt(process.env.POST_COUNT ?? "1", 10);
const DELAY_BETWEEN_MS = process.env.DELAY_BETWEEN_MS
  ? parseInt(process.env.DELAY_BETWEEN_MS, 10)
  : randomBetween(5 * 60_000, 15 * 60_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Return the UTF-8 byte offset of the first occurrence of needle in haystack. */
function byteIndexOf(haystack: string, needle: string): number {
  const enc = new TextEncoder();
  const haystackBytes = enc.encode(haystack);
  const needleBytes = enc.encode(needle);
  outer: for (let i = 0; i <= haystackBytes.length - needleBytes.length; i++) {
    for (let j = 0; j < needleBytes.length; j++) {
      if (haystackBytes[i + j] !== needleBytes[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function byteLength(str: string): number {
  return new TextEncoder().encode(str).length;
}

// ---------------------------------------------------------------------------
// Chaturbate API
// ---------------------------------------------------------------------------

interface CbRoom {
  username: string;
  display_name: string;
  subject: string;
  num_users: number;
  tags: string[];
  image_url: string;
  chat_room_url: string;
}

interface CbApiResponse {
  count: number;
  results: CbRoom[];
}

async function fetchRooms(tag: string): Promise<CbRoom[]> {
  const url = new URL(
    "https://chaturbate.com/api/public/affiliates/onlinerooms/"
  );
  url.searchParams.set("wm", CB_WM);
  url.searchParams.set("client_ip", "request_ip");
  url.searchParams.set("tag", tag);
  url.searchParams.set("limit", "100");

  const res = await fetch(url.toString(), {
    headers: { "User-Agent": "CamBot/1.0", Accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(
      `Chaturbate API error: ${res.status} ${res.statusText} for tag "${tag}"`
    );
  }

  const data = (await res.json()) as CbApiResponse;
  return data.results ?? [];
}

async function pickRoom(): Promise<{ room: CbRoom; tag: string } | null> {
  const shuffledTags = [...CB_TAGS].sort(() => Math.random() - 0.5);

  for (const tag of shuffledTags) {
    try {
      const rooms = await fetchRooms(tag);
      const eligible = rooms.filter((r) => r.num_users >= CB_MIN_VIEWERS);
      if (eligible.length > 0) {
        return { room: pickRandom(eligible), tag };
      }
    } catch (err) {
      console.error(`Failed to fetch rooms for tag "${tag}":`, err);
    }
    await sleep(1_000);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Affiliate link builder
// ---------------------------------------------------------------------------

function affiliateLink(username: string): string {
  return `https://chaturbate.com/${username}/?tour=dUxc&campaign=${CB_WM}&track=default`;
}

// ---------------------------------------------------------------------------
// Image upload
// ---------------------------------------------------------------------------

async function uploadRoomImage(
  agent: BskyAgent,
  imageUrl: string,
  altText: string
): Promise<{ image: unknown; alt: string } | null> {
  try {
    const res = await fetch(imageUrl, { headers: { "User-Agent": "CamBot/1.0" } });
    if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`);

    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    const arrayBuffer = await res.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);

    const upload = await agent.uploadBlob(uint8, { encoding: contentType });
    return { image: upload.data.blob, alt: altText };
  } catch (err) {
    console.warn("⚠️  Could not upload image:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Post composer
// ---------------------------------------------------------------------------

const OPENERS = [
  "🔴 LIVE NOW:",
  "👀 Live right now:",
  "🔥 On cam now:",
  "💦 Streaming live:",
  "✨ Don't miss this —",
  "🎥 Live & taking requests:",
  "🌶️ Currently live:",
  "😈 Online now:",
];

/** Build hashtag string from the room's own tags (max 6) + always #cams #live */
function buildHashtags(room: CbRoom, searchTag: string): string {
  const seen = new Set<string>();
  const tags: string[] = [];

  const sanitize = (t: string) =>
    "#" + t.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();

  // Always include the tag we searched for first
  const first = sanitize(searchTag);
  seen.add(first);
  tags.push(first);

  // Add room's own tags (up to 5 more)
  for (const t of room.tags ?? []) {
    const h = sanitize(t);
    if (h.length > 1 && !seen.has(h)) {
      seen.add(h);
      tags.push(h);
      if (tags.length >= 6) break;
    }
  }

  tags.push("#cams", "#live");
  return tags.join(" ");
}

interface PostPayload {
  text: string;
  /** Byte start of the "Watch Now" anchor in text */
  watchNowByteStart: number;
  watchNowByteEnd: number;
  affiliateUrl: string;
  hashtagsText: string;
}

function buildPostPayload(room: CbRoom, tag: string, link: string): PostPayload {
  const opener = pickRandom(OPENERS);
  const name = room.display_name || room.username;
  const viewers = room.num_users.toLocaleString();
  const hashtagsText = buildHashtags(room, tag);

  let subject = (room.subject ?? "").trim();
  if (subject.length > 80) subject = subject.slice(0, 77) + "…";

  // "Watch Now" is the visible hyperlink anchor — no raw URL in the text
  const WATCH_NOW = "Watch Now";

  const lines = [
    `${opener} ${name}`,
    subject ? `"${subject}"` : null,
    `👥 ${viewers} watching`,
    "",
    WATCH_NOW,
    "",
    hashtagsText,
  ].filter((l): l is string => l !== null);

  const text = lines.join("\n");

  const watchNowByteStart = byteIndexOf(text, WATCH_NOW);
  const watchNowByteEnd = watchNowByteStart + byteLength(WATCH_NOW);

  return { text, watchNowByteStart, watchNowByteEnd, affiliateUrl: link, hashtagsText };
}

// ---------------------------------------------------------------------------
// Bluesky poster
// ---------------------------------------------------------------------------

async function postToBluesky(
  agent: BskyAgent,
  payload: PostPayload,
  imageEmbed: { image: unknown; alt: string } | null
): Promise<void> {
  const { text, watchNowByteStart, watchNowByteEnd, affiliateUrl } = payload;

  // Use RichText to auto-detect #hashtag facets
  const rt = new RichText({ text });
  await rt.detectFacets(agent);

  // Manually add the "Watch Now" → affiliate link facet
  const watchNowFacet = {
    index: { byteStart: watchNowByteStart, byteEnd: watchNowByteEnd },
    features: [{ $type: "app.bsky.richtext.facet#link", uri: affiliateUrl }],
  };

  const facets = [...(rt.facets ?? []), watchNowFacet];

  const postRecord: Record<string, unknown> = {
    $type: "app.bsky.feed.post",
    text: rt.text,
    facets,
    createdAt: new Date().toISOString(),
  };

  if (imageEmbed) {
    postRecord.embed = {
      $type: "app.bsky.embed.images",
      images: [imageEmbed],
    };
  }

  await agent.post(postRecord);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  if (!BSKY_HANDLE || !BSKY_APP_PASSWORD) {
    console.error("Missing BSKY_HANDLE or BSKY_APP_PASSWORD environment variables.");
    process.exit(1);
  }

  if (CB_TAGS.length === 0) {
    console.error("CB_TAGS is empty — set at least one tag.");
    process.exit(1);
  }

  console.log(`Bluesky handle : ${BSKY_HANDLE}`);
  console.log(`Tags to search : ${CB_TAGS.join(", ")}`);
  console.log(`Min viewers    : ${CB_MIN_VIEWERS}`);
  console.log(`Posts this run : ${POST_COUNT}`);

  const agent = new BskyAgent({ service: "https://bsky.social" });
  await agent.login({ identifier: BSKY_HANDLE, password: BSKY_APP_PASSWORD });
  console.log("✅ Logged into Bluesky");

  const postedUsernames = new Set<string>();

  for (let i = 0; i < POST_COUNT; i++) {
    if (i > 0) {
      console.log(`⏳ Waiting ${Math.round(DELAY_BETWEEN_MS / 60_000)} min before next post…`);
      await sleep(DELAY_BETWEEN_MS);
    }

    let attempt = 0;
    let pick: { room: CbRoom; tag: string } | null = null;

    while (attempt < 5) {
      pick = await pickRoom();
      if (!pick || !postedUsernames.has(pick.room.username)) break;
      attempt++;
    }

    if (!pick) {
      console.warn(`⚠️  No eligible rooms found for post ${i + 1}. Skipping.`);
      continue;
    }

    const { room, tag } = pick;
    const link = affiliateLink(room.username);
    const payload = buildPostPayload(room, tag, link);

    console.log(`\n📝 Post ${i + 1}/${POST_COUNT}`);
    console.log(`   Room    : ${room.username} (${room.num_users} viewers)`);
    console.log(`   Tag     : ${tag}`);
    console.log(`   Image   : ${room.image_url}`);
    console.log(`   Tags    : ${(room.tags ?? []).join(", ")}`);
    console.log(`   Preview :\n${payload.text}\n`);

    // Upload preview image
    const imageEmbed = room.image_url
      ? await uploadRoomImage(
          agent,
          room.image_url,
          `${room.display_name || room.username} live on Chaturbate`
        )
      : null;

    if (imageEmbed) {
      console.log("🖼️  Image uploaded successfully");
    }

    try {
      await postToBluesky(agent, payload, imageEmbed);
      postedUsernames.add(room.username);
      console.log(`✅ Posted successfully!`);
    } catch (err) {
      console.error(`❌ Failed to post to Bluesky:`, err);
    }

    await sleep(2_000);
  }

  console.log("\n🏁 Bot run complete.");
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
