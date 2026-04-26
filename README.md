# Screenshot Agent

this is a simple script to clean the screenshot mess on your mac desktop. 

i used gemini 1.5 flash because it's fast and free. but i didn't want the ai just moving my files blindly and messing things up. so i made a two-step thing. you get to check a json file before anything actually moves.

## Tech
* node.js and typescript.
* pure functional programming. no classes.
* gemini 1.5 flash.

## How it works

1. **plan.ts** it looks at your desktop, turns the screenshots to base64, and asks gemini to group them into generic folders (like Social_Media, Finance, Code_Snippets). it doesn't move files yet. it just makes a `reorganization_plan.json` file.

2. **The JSON check**
open the json file. this is the ui. if gemini named a folder something stupid, just change the text. if you don't want a file moved at all, change the category to `"SKIP"`.

3. **apply.ts**
this one reads the json file, makes the folders, and actually moves your screenshots.

## Setup

1. run this:
`npm install`

2. make a `.env` file. put your own api key, i'm not giving you mine.
`GEMINI_API_KEY=your_key_here`
`GEMINI_MODEL=gemini-1.5-flash`

## How to use

generate the plan:
`npx tsx plan.ts`

check the `reorganization_plan.json` file on your desktop and fix what you want.

then move the files:
`npx tsx apply.ts`
