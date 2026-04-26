import { readFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const DESKTOP_DIR = path.join(os.homedir(), "Desktop");
const PLAN_FILE = path.join(DESKTOP_DIR, "reorganization_plan.json");

const run = async () => {
  console.log(`🚀 Executing plan from ${PLAN_FILE}...`);
  
  let planData: Record<string, string>;
  try {
    const rawData = await readFile(PLAN_FILE, 'utf8');
    planData = JSON.parse(rawData);
  } catch (error) {
    console.error(`❌ Could not read or parse ${PLAN_FILE}. Did you run the plan script first?`);
    return;
  }

  const files = Object.keys(planData);
  
  if (files.length === 0) {
    console.log("🤷‍♂️ No files in plan. Exiting.");
    return;
  }

  for (const fileName of files) {
    const categoryName = planData[fileName];
    
    // The Human Override: If you changed the JSON value to "SKIP", it ignores it
    if (!categoryName || categoryName === 'SKIP') {
       console.log(`⏩ Skipping ${fileName}`);
       continue;
    }

    const sourcePath = path.join(DESKTOP_DIR, fileName);
    const targetDir = path.join(DESKTOP_DIR, "Organized_Screenshots", categoryName);
    const targetPath = path.join(targetDir, fileName);

    try {
      await mkdir(targetDir, { recursive: true });
      await rename(sourcePath, targetPath);
      console.log(`✅ Moved ${fileName} -> /${categoryName}`);
    } catch (err) {
      console.log(`❌ FAILED to move ${fileName}: ${err instanceof Error ? err.message : err}`);
    }
  }
  
  console.log("\n🏁 Execution complete.");
};

run();