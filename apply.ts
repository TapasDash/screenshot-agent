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

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Operation timed out (${ms}ms)`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
};

const processFile = async (filePath: string, fileName: string) => {
  const fileStat = await stat(filePath);
  if (fileStat.size === 0) throw new Error("0 byte file");

  const ext = path.extname(fileName).toLowerCase();
  const isImage = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext);

  let prompt = `Task: Categorize this file into a broad, reusable folder name.
Constraints: Use generic groupings (e.g., Finance, Code_Projects, Memes, Work_Docs, Installers). NO hyper-specific names.
Format: Strict JSON only. Output: {"category": "FolderName"}`;

  let result;

  if (isImage) {
    // 👁️ VISION ROUTE: For images, look at the actual pixels
    const base64 = (await readFile(filePath)).toString("base64");
    const mimeType = ext === '.png' ? "image/png" : "image/jpeg";
    
    result = await model.generateContent([
      prompt,
      { inlineData: { data: base64, mimeType } }
    ]);
  } else {
    // 🧠 TEXT ROUTE: For docs/zips/csvs, just analyze the filename
    prompt += `\nAnalyze this filename and extension: "${fileName}"`;
    result = await model.generateContent([prompt]);
  }
  
  const rawCategory = JSON.parse(result.response.text().trim()).category;
  return rawCategory.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
};

const run = async () => {
  console.log(`🚀 Scanning ${DESKTOP_DIR} for ALL files...`);
  
  // Read all items, but filter out directories, hidden files, and the plan file itself
  const items = await readdir(DESKTOP_DIR, { withFileTypes: true });
  const validFiles = items
    .filter(item => 
      item.isFile() && 
      !item.name.startsWith('.') && 
      item.name !== "reorganization_plan.json" &&
      !item.name.endsWith('.ts') // ignore your scripts if they are on the desktop
    )
    .map(item => item.name);
  
  if (validFiles.length === 0) {
    console.log("🤷‍♂️ No clutter found. Desktop is clean. Exiting.");
    return;
  }

  console.log(`🎯 Found ${validFiles.length} files. Generating plan...\n`);
  const plan: Record<string, string> = {};

  for (let i = 0; i < validFiles.length; i++) {
    const fileName = validFiles[i];
    const filePath = path.join(DESKTOP_DIR, fileName);

    try {
      process.stdout.write(`[${i + 1}/${validFiles.length}] Categorizing ${fileName} -> `);
      // Images get 15s timeout for iCloud, text files evaluate instantly
      const categoryName = await withTimeout(processFile(filePath, fileName), 15000);
      plan[fileName] = categoryName;
      console.log(`✅ ${categoryName}`);
    } catch (err) {
      console.log(`❌ FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }
  
  await writeFile(PLAN_FILE, JSON.stringify(plan, null, 2));
  console.log(`\n📄 Master Plan written to ${PLAN_FILE}. Review it, edit it, then run apply.ts!`);
};

run();