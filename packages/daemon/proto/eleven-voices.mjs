// Which voices can this key reach, and which are the most used?
// Prints ids and labels only, never the key.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const key = (
  process.env.ELEVENLABS_API_KEY ||
  readFileSync(path.join(os.homedir(), ".kikoe", "elevenlabs_key.txt"), "utf8")
).trim();
const get = async (p) => {
  const r = await fetch("https://api.elevenlabs.io" + p, { headers: { "xi-api-key": key } });
  if (!r.ok) throw new Error(p + " " + r.status + " " + (await r.text()).slice(0, 200));
  return r.json();
};
const mode = process.argv[2] ?? "all";
if (mode === "all" || mode === "mine") {
  const { voices } = await get("/v1/voices");
  console.log("--- in your library (premade + added) ---");
  for (const v of voices)
    console.log(
      `${v.voice_id}  ${v.name.padEnd(12)} ${v.category.padEnd(12)} ${v.labels?.gender ?? "?"}  ${v.labels?.accent ?? ""}  ${v.labels?.description ?? ""}  ${v.labels?.use_case ?? ""}`,
    );
}
if (mode === "all" || mode === "popular") {
  const q = new URLSearchParams({
    page_size: "8",
    gender: "female",
    language: "en",
    sort: "usage_character_count_1y",
  });
  const { voices } = await get("/v1/shared-voices?" + q);
  console.log("\n--- most used female voices in the library, past year ---");
  for (const v of voices)
    console.log(
      `${v.voice_id}  ${v.name.padEnd(14)} ${(v.accent ?? "").padEnd(10)} ${String(Math.round((v.usage_character_count_1y ?? 0) / 1e6)).padStart(6)}M chars  ${v.public_owner_id}  free_slots=${v.free_users_allowed}  ${v.descriptive ?? ""}`,
    );
}
