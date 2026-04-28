import { readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const DESKTOP_DIR = path.join(os.homedir(), "Desktop");
const ORGANIZED_DIR = path.join(DESKTOP_DIR, "Organized_Screenshots");

const run = async () => {
  console.log(`🚀 Reverting files from ${ORGANIZED_DIR} back to Desktop...`);

  try {
    await stat(ORGANIZED_DIR);
  } catch (e) {
    console.log("🤷‍♂️ Organized_Screenshots folder not found. Your desktop is already messy.");
    return;
  }

  // Look inside the Organized_Screenshots folder
  const categories = await readdir(ORGANIZED_DIR, { withFileTypes: true });
  let moveCount = 0;

  for (const category of categories) {
    if (!category.isDirectory()) continue;

    const categoryPath = path.join(ORGANIZED_DIR, category.name);
    const files = await readdir(categoryPath);

    for (const file of files) {
      // Ignore hidden mac files like .DS_Store
      if (file.startsWith('.')) continue; 

      const sourcePath = path.join(categoryPath, file);
      const targetPath = path.join(DESKTOP_DIR, file);

      try {
         await rename(sourcePath, targetPath);
         moveCount++;
      } catch (err) {
         console.log(`❌ Failed to move ${file}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  console.log(`🔙 Dumped ${moveCount} files back onto the Desktop.`);
  console.log(`🧹 Nuking the empty folders...`);

  try {
    await rm(ORGANIZED_DIR, { recursive: true, force: true });
    console.log("✅ Evidence destroyed.");
    console.log("🏁 Desktop is officially a mess again. Hit record!");
  } catch (e) {
    console.log("⚠️ Could not delete the Organized_Screenshots folder automatically.");
  }
};

run();