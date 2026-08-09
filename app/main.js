const fs = require("fs");
const path = require("path");
const readline = require("readline");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "$ ",
});

const builtins = new Set(["echo", "exit", "type"]);

rl.prompt();

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    rl.prompt();
    return;
  }

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  if (cmd === "exit") {
    rl.close();
    process.exit(0);
  }

  if (cmd === "echo") {
    console.log(args.join(" "));
    rl.prompt();
    return;
  }

  if (cmd === "type") {
    if (args.length > 0) {
      const target = args[0];
      if (builtins.has(target)) {
        console.log(`${target} is a shell builtin`);
      } else {
        const pathDirs = process.env.PATH ? process.env.PATH.split(path.delimiter) : [];
        let found = false;
        for (const dir of pathDirs) {
          if (!dir) {
            continue;
          }

          const candidate = path.join(dir, target);
          try {
            fs.accessSync(candidate, fs.constants.F_OK | fs.constants.X_OK);
            console.log(`${target} is ${candidate}`);
            found = true;
            break;
          } catch (err) {
            // File missing or not executable; continue searching.
          }
        }

        if (!found) {
          console.log(`${target}: not found`);
        }
      }
    }
    rl.prompt();
    return;
  }

  console.log(`${cmd}: command not found`);
  rl.prompt();
});
