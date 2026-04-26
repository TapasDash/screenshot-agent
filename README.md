# 🚀 Screenshot Agent (The Desktop Bulldozer)

A zero-bloat, 100% functional TypeScript script to nuke your Mac desktop clutter. 

I built this using **Gemini 1.5 Flash** because it’s insanely fast at processing heavy Retina screenshots, and best of all, it's free on the basic tier lol. 

Instead of letting an AI blindly move your files and risk yeeting your tax returns into a "Memes" folder, this tool uses a two-step "Human-in-the-Loop" architecture. You get total veto power via a JSON contract before any files actually move.

## ⚙️ The Loadout

* **Engine:** Node.js (v24+ natively supports `.env`), TypeScript (`tsx`).
* **Paradigm:** Pure functional programming. Zero classes, zero over-engineered abstractions. Just straight execution.
* **Brain:** `@google/generative-ai` (Gemini 1.5 Flash). 

## 🗺️ The Game Plan

The system is split into two phases to keep you in control.

### 1. The Thinker (`plan.ts`)
Scans `~/Desktop` for Mac screenshots, converts them to Base64, and asks Gemini to assign them to broad, reusable buckets (e.g., `Finance`, `Code_Snippets`, `Dating_Apps`). 

It does **not** touch your file system yet. It just drops a `reorganization_plan.json` file on your desktop. This is your dry run.

### 2. The JSON Contract (God Mode)
That JSON file is your headless UI. Open it in any text editor and review the AI's logic.
* AI missed the mark? Rename the category directly in the JSON.
* Don't want a file moved? Change its value to `"SKIP"`.

### 3. The Doer (`apply.ts`)
Reads your approved JSON contract, automatically creates the necessary directories inside `~/Desktop/Organized_Screenshots/`, and executes the physical file moves. 

## 🛠️ Setup & Config

1. Install the dependencies:
   ```bash
   npm install
