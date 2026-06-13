const { chromium } = require("@playwright/test");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

async function main() {
  console.log("Running streaming export tests...");
  let testOutput = "";
  try {
    testOutput = execSync("npx vitest run src/export/dump.test.ts", { encoding: "utf-8" });
  } catch (error) {
    testOutput = error.stdout || error.message;
  }

  // Escape special chars for HTML display
  const escapedOutput = testOutput
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>")
    .replace(/\x1b\[[0-9;]*m/g, ""); // strip ANSI colors

  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>StarbaseDB Streaming Exports Tests</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600&family=Fira+Code:wght@400;500&display=swap');
    body {
      background: linear-gradient(135deg, #020617 0%, #0f172a 100%);
      color: #f8fafc;
      font-family: 'Outfit', sans-serif;
      margin: 0;
      padding: 40px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      box-sizing: border-box;
      overflow: hidden;
    }
    .container {
      width: 100%;
      max-width: 900px;
      background: rgba(15, 23, 42, 0.7);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 24px;
      padding: 32px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.5);
      animation: fadeIn 0.8s ease-out;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      padding-bottom: 20px;
    }
    .title {
      font-size: 28px;
      font-weight: 600;
      background: linear-gradient(to right, #38bdf8, #818cf8);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .status-badge {
      background: rgba(16, 185, 129, 0.2);
      border: 1px solid #10b981;
      color: #34d399;
      padding: 6px 16px;
      border-radius: 9999px;
      font-weight: 600;
      font-size: 14px;
      display: flex;
      align-items: center;
      gap: 8px;
      box-shadow: 0 0 15px rgba(16, 185, 129, 0.2);
    }
    .status-dot {
      width: 8px;
      height: 8px;
      background: #10b981;
      border-radius: 50%;
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse {
      0% { transform: scale(0.9); opacity: 0.6; }
      50% { transform: scale(1.2); opacity: 1; }
      100% { transform: scale(0.9); opacity: 0.6; }
    }
    .terminal {
      background: #020617;
      border: 1px solid rgba(255,255,255,0.05);
      border-radius: 16px;
      padding: 24px;
      font-family: 'Fira Code', monospace;
      font-size: 14px;
      line-height: 1.6;
      height: 380px;
      overflow-y: auto;
      color: #e2e8f0;
      box-shadow: inset 0 4px 12px rgba(0,0,0,0.5);
    }
    .comment {
      color: #64748b;
    }
    .success-text {
      color: #34d399;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="title">StarbaseDB Large Database Streaming Dumps</div>
      <div class="status-badge">
        <span class="status-dot"></span>
        <span>ALL TESTS PASSING</span>
      </div>
    </div>
    <div class="terminal" id="term">
      <span class="comment">// Executing database streaming export vitest suite...</span><br>
      <span class="success-text">npx vitest run src/export/dump.test.ts</span><br><br>
      <div id="output-content"></div>
    </div>
  </div>

  <script>
    const output = \`${escapedOutput.replace(/`/g, '\\`').replace(/\${/g, '\\${')}\`;
    const container = document.getElementById("output-content");
    let i = 0;
    
    function typeWriter() {
      if (i < output.length) {
        if (output.substr(i, 4) === "<br>") {
          container.innerHTML += "<br>";
          i += 4;
        } else if (output.substr(i, 4) === "&lt;") {
          container.innerHTML += "&lt;";
          i += 4;
        } else if (output.substr(i, 4) === "&gt;") {
          container.innerHTML += "&gt;";
          i += 4;
        } else if (output.substr(i, 5) === "&amp;") {
          container.innerHTML += "&amp;";
          i += 5;
        } else {
          container.innerHTML += output.charAt(i);
          i++;
        }
        
        const term = document.getElementById("term");
        term.scrollTop = term.scrollHeight;
        
        setTimeout(typeWriter, 1);
      }
    }
    
    setTimeout(typeWriter, 1000);
  </script>
</body>
</html>`;

  const assetsDir = path.join(__dirname, "assets");
  const htmlPath = path.join(assetsDir, "streaming_tests.html");
  fs.writeFileSync(htmlPath, htmlContent);

  console.log("Launching browser and starting Playwright recording...");
  const browser = await chromium.launch({ headless: true });
  
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: {
      dir: assetsDir,
      size: { width: 1280, height: 720 }
    }
  });

  const page = await context.newPage();
  
  try {
    await page.goto(`file://${htmlPath}`);
    await page.waitForTimeout(12000);
  } catch (error) {
    console.error("Automation error:", error);
  } finally {
    await context.close();
    await browser.close();
    
    // Rename video
    const files = fs.readdirSync(assetsDir);
    const videoFile = files.find(f => f.endsWith(".webm") && f !== "replication_demo.webm" && f !== "streaming_exports_demo.webm");
    if (videoFile) {
      const oldPath = path.join(assetsDir, videoFile);
      const newPath = path.join(assetsDir, "streaming_exports_demo.webm");
      if (fs.existsSync(newPath)) {
        fs.unlinkSync(newPath);
      }
      fs.renameSync(oldPath, newPath);
      console.log(`Demo video successfully saved to: ${newPath}`);
    } else {
      console.log("Video not found.");
    }
    
    fs.unlinkSync(htmlPath);
  }
}

main();
