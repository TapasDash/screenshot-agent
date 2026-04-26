import "dotenv/config";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { GoogleGenerativeAI } from "@google/generative-ai";

const DESKTOP_DIR = path.join(os.homedir(), "Desktop");
const PLAN_FILE = path.join(DESKTOP_DIR, "reorganization_plan.json");
const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) throw new Error("Missing GEMINI_API_KEY in environment");

const model = new GoogleGenerativeAI(API_KEY).getGenerativeModel({
  model: process.env.GEMINI_MODEL || "gemini-1.5-flash",
  generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
});

const PROMPT = `Task: Categorize screenshot into a broad, reusable folder name.
Constraints: Use generic groupings (e.g., Social_Media, Code_Snippets, Finance, Memes). NO hyper-specific names.
Format: Strict JSON only. No markdown.
Output: {"category": "FolderName"}`;

// Prevents the script from hanging if iCloud tries to download a massive file
const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Operation timed out (${ms}ms)`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
};

const processSingleImage = async (filePath: string) => {
  const fileStat = await stat(filePath);
  if (fileStat.size === 0) throw new Error("0 byte file (iCloud stub)");

  const base64 = (await readFile(filePath)).toString("base64");
  const mimeType = filePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
  
  const result = await model.generateContent([
    PROMPT,
    { inlineData: { data: base64, mimeType } },
  ]);
  
  const rawCategory = JSON.parse(result.response.text().trim()).category;
  return rawCategory.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
};

const run = async () => {
  console.log(`🚀 Scanning ${DESKTOP_DIR} to generate a plan...`);
  
  const files = await readdir(DESKTOP_DIR);
  const screenshots = files.filter(f => f.startsWith("Screen") && f.match(/\.(png|jpg|jpeg)$/i));
  
  if (screenshots.length === 0) {
    console.log("🤷‍♂️ No screenshots found. Exiting.");
    return;
  }

  const plan: Record<string, string> = {};

  for (let i = 0; i < screenshots.length; i++) {
    const fileName = screenshots[i];
    const filePath = path.join(DESKTOP_DIR, fileName);

    try {
      process.stdout.write(`[${i + 1}/${screenshots.length}] Planning for ${fileName} -> `);
      const categoryName = await withTimeout(processSingleImage(filePath), 15000);
      plan[fileName] = categoryName;
      console.log(`✅ ${categoryName}`);
    } catch (err) {
      console.log(`❌ FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }
  
  await writeFile(PLAN_FILE, JSON.stringify(plan, null, 2));
  console.log(`\n📄 Plan written to ${PLAN_FILE}. Review and edit it, then run the apply script.`);
};

run();