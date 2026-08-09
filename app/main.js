const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const readline = require("readline");

const completions = ["echo", "exit"];

function getPathExecutables(prefix) {
  const entries = new Set();
  const pathEnv = process.env.PATH || "";
  const pathDirs = pathEnv.split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir) {
      continue;
    }
    try {
      const names = fs.readdirSync(dir);
      for (const name of names) {
        if (!name.startsWith(prefix)) {
          continue;
        }
        const candidate = path.join(dir, name);
        try {
          fs.accessSync(candidate, fs.constants.F_OK | fs.constants.X_OK);
          entries.add(name);
        } catch (err) {
          // ignore non-executable or inaccessible files
        }
      }
    } catch (err) {
      // ignore directories that can't be read or don't exist
    }
  }
  return Array.from(entries).sort();
}

let rl;
const completerState = {
  prefix: null,
  count: 0,
};

// Map of registered completion specs: command -> { type: 'C', path }
const completionSpecs = new Map();
// Background job tracking
let nextJobId = 1;
const jobs = new Map();

function longestCommonPrefix(array) {
  if (array.length === 0) return "";
  let prefix = array[0];
  for (let i = 1; i < array.length; i += 1) {
    while (!array[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (prefix === "") {
        return "";
      }
    }
  }
  return prefix;
}

function getMatchesInDirectory(directory, prefix) {
  try {
    const entries = fs.readdirSync(directory);
    return entries
      .filter((name) => name.startsWith(prefix))
      .sort()
      .map((name) => {
        const candidatePath = path.join(directory, name);
        let isDirectory = false;
        try {
          isDirectory = fs.statSync(candidatePath).isDirectory();
        } catch (err) {
          // ignore stat failures
        }
        return { name, isDirectory };
      });
  } catch (err) {
    return [];
  }
}

function getFilenameMatches(prefix) {
  return getMatchesInDirectory(process.cwd(), prefix);
}

function getNestedPathMatches(token) {
  const slashIndex = token.lastIndexOf("/");
  if (slashIndex === -1) {
    return [];
  }

  const dirToken = token.slice(0, slashIndex + 1);
  const basenamePrefix = token.slice(slashIndex + 1);
  const searchDir = path.resolve(process.cwd(), token.slice(0, slashIndex));

  const matches = getMatchesInDirectory(searchDir, basenamePrefix);
  return matches.map((entry) => ({
    full: `${dirToken}${entry.name}`,
    isDirectory: entry.isDirectory,
  }));
}

function completionHandler(line) {
  const trimmed = line.trimStart();
  if (trimmed.length === 0) {
    process.stdout.write("\x07");
    completerState.prefix = null;
    completerState.count = 0;
    return [[], line];
  }

  const lastSpaceIndex = line.lastIndexOf(" ");
  if (lastSpaceIndex !== -1) {
    const token = line.slice(lastSpaceIndex + 1);
    // Determine words before the token to build completer args
    const before = line.slice(0, lastSpaceIndex).trim();
    const wordsBefore = before.length ? before.split(/\s+/) : [];
    const commandName = wordsBefore.length ? wordsBefore[0] : "";
    const previousWord = wordsBefore.length ? wordsBefore[wordsBefore.length - 1] : "";

    // If a completer is registered for the command, invoke it with (command, token, previousWord)
    const spec = completionSpecs.get(commandName);
    if (spec && spec.type === "C") {
      try {
        const compLine = line.replace(/\r?\n$/, "");
        const compPoint = String(Buffer.byteLength(compLine));
        const out = childProcess.execFileSync(spec.path, [commandName, token, previousWord], {
          encoding: "utf8",
          env: Object.assign({}, process.env, { COMP_LINE: compLine, COMP_POINT: compPoint }),
        });
        const lines = Array.from(new Set(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))).sort();
        if (lines.length === 1) {
          return [[`${lines[0]} `], token];
        }

        if (lines.length > 1) {
          // Try LCP across completer-provided candidates
          const common = longestCommonPrefix(lines);
          if (common.length > token.length) {
            return [[common], token];
          }

          if (completerState.prefix === token) {
            completerState.count += 1;
          } else {
            completerState.prefix = token;
            completerState.count = 1;
          }

          if (completerState.count === 1) {
            process.stdout.write("\x07");
            return [[], token];
          }

          const formatted = lines.join("  ");
          process.stdout.write(`\n${formatted}\n`);
          rl.prompt(true);
          return [[], token];
        }
      } catch (err) {
        // on error, fall through to normal behavior (bell)
      }
    }

    const nestedHits = getNestedPathMatches(token);
    const filenameHits = token.includes("/") ? [] : getFilenameMatches(token);
    const plainHits = filenameHits.map((entry) => ({
      full: entry.name,
      isDirectory: entry.isDirectory,
    }));
    const matches = nestedHits.length > 0 ? nestedHits : plainHits;

    if (matches.length === 1) {
      completerState.prefix = null;
      completerState.count = 0;
      const suffix = matches[0].isDirectory ? "/" : " ";
      return [[`${matches[0].full}${suffix}`], token];
    }

    // If multiple matches, try to complete to their longest common prefix (LCP)
    if (matches.length > 1) {
      const names = matches.map((m) => m.full);
      const commonPrefix = longestCommonPrefix(names);
      if (commonPrefix.length > token.length) {
        completerState.prefix = null;
        completerState.count = 0;
        return [[commonPrefix], token];
      }
    }

    if (completerState.prefix === token) {
      completerState.count += 1;
    } else {
      completerState.prefix = token;
      completerState.count = 1;
    }

    if (completerState.count === 1) {
      process.stdout.write("\x07");
      return [[], token];
    }

    const formatted = matches
      .map((entry) => `${entry.full}${entry.isDirectory ? "/" : ""}`)
      .join("  ");
    process.stdout.write(`\n${formatted}\n`);
    rl.prompt(true);
    return [[], token];
  }

  const hits = completions.filter((cmd) => cmd.startsWith(trimmed));
  const pathHits = getPathExecutables(trimmed);
  const allHits = [...new Set([...hits, ...pathHits])].sort();

  if (allHits.length === 0) {
    process.stdout.write("\x07");
    completerState.prefix = null;
    completerState.count = 0;
    return [[], line];
  }

  if (allHits.length === 1) {
    completerState.prefix = null;
    completerState.count = 0;
    return [[`${allHits[0]} `], line];
  }

  const commonPrefix = longestCommonPrefix(allHits);
  if (commonPrefix.length > trimmed.length) {
    completerState.prefix = null;
    completerState.count = 0;
    return [[commonPrefix], line];
  }

  if (completerState.prefix === trimmed) {
    completerState.count += 1;
  } else {
    completerState.prefix = trimmed;
    completerState.count = 1;
  }

  if (completerState.count === 1) {
    process.stdout.write("\x07");
    return [[], line];
  }

  process.stdout.write(`\n${allHits.join("  ")}\n`);
  rl.prompt(true);
  return [[], line];
}

rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "$ ",
  completer: completionHandler,
});

const builtins = new Set(["echo", "exit", "type", "pwd", "cd", "complete", "jobs"]);

function parseCommandLine(line) {
  const tokens = [];
  let current = "";
  let quoteChar = null;
  let escapeNext = false;

  const pushCurrent = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (escapeNext) {
      current += char;
      escapeNext = false;
      continue;
    }

    if (!quoteChar && char === "\\") {
      escapeNext = true;
      continue;
    }

    if (quoteChar) {
      if (quoteChar === '"' && char === "\\") {
        const nextChar = line[i + 1];
        if (nextChar === '"' || nextChar === "\\") {
          current += nextChar;
          i += 1;
          continue;
        }
        current += char;
        continue;
      }

      if (char === quoteChar) {
        quoteChar = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quoteChar = char;
      continue;
    }

    if (char === " " || char === "\t") {
      pushCurrent();
      continue;
    }

    if (char === ">") {
      const nextChar = line[i + 1];
      if (nextChar === ">") {
        if (current === "1") {
          tokens.push("1>>");
          current = "";
        } else if (current === "2") {
          tokens.push("2>>");
          current = "";
        } else {
          pushCurrent();
          tokens.push(">>");
        }
        i += 1;
      } else if (current === "1") {
        tokens.push("1>");
        current = "";
      } else if (current === "2") {
        tokens.push("2>");
        current = "";
      } else {
        pushCurrent();
        tokens.push(">");
      }
      continue;
    }

    current += char;
  }

  pushCurrent();

  const args = [];
  let stdoutRedirect = null;
  let stderrRedirect = null;
  let stdoutAppend = false;
  let stderrAppend = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === ">" || token === "1>") {
      if (i + 1 < tokens.length) {
        stdoutRedirect = tokens[i + 1];
        stdoutAppend = false;
        i += 1;
      }
      continue;
    }
    if (token === ">>" || token === "1>>") {
      if (i + 1 < tokens.length) {
        stdoutRedirect = tokens[i + 1];
        stdoutAppend = true;
        i += 1;
      }
      continue;
    }
    if (token === "2>") {
      if (i + 1 < tokens.length) {
        stderrRedirect = tokens[i + 1];
        stderrAppend = false;
        i += 1;
      }
      continue;
    }
    if (token === "2>>") {
      if (i + 1 < tokens.length) {
        stderrRedirect = tokens[i + 1];
        stderrAppend = true;
        i += 1;
      }
      continue;
    }
    args.push(token);
  }

  return { args, stdoutRedirect, stdoutAppend, stderrRedirect, stderrAppend };
}

function findExecutable(command) {
  const pathDirs = process.env.PATH ? process.env.PATH.split(path.delimiter) : [];
  for (const dir of pathDirs) {
    if (!dir) {
      continue;
    }

    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.F_OK | fs.constants.X_OK);
      return candidate;
    } catch (err) {
      // File missing or not executable; continue searching.
    }
  }
  return null;
}

rl.prompt();

function writeOutput(destination, text, append = false) {
  if (destination) {
    const flag = append ? "a" : "w";
    fs.writeFileSync(destination, text + "\n", { encoding: "utf8", flag });
  } else {
    console.log(text);
  }
}

function writeError(destination, text) {
  if (destination) {
    fs.writeFileSync(destination, text + "\n", { encoding: "utf8" });
  } else {
    console.error(text);
  }
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    rl.prompt();
    return;
  }

  const { args, stdoutRedirect, stdoutAppend, stderrRedirect, stderrAppend } = parseCommandLine(line);
  if (args.length === 0) {
    rl.prompt();
    return;
  }

  // Detect background execution token '&' at end of args
  let runInBackground = false;
  if (args.length > 0 && args[args.length - 1] === "&") {
    runInBackground = true;
    args.pop();
  }

  const cmd = args[0];
  const cmdArgs = args.slice(1);

  if (cmd === "exit") {
    rl.close();
    process.exit(0);
  }

  if (cmd === "echo") {
    writeOutput(stdoutRedirect, cmdArgs.join(" "), stdoutAppend);
    if (stderrRedirect) {
      fs.closeSync(fs.openSync(stderrRedirect, stderrAppend ? "a" : "w"));
    }
    rl.prompt();
    return;
  }

  if (cmd === "pwd") {
    writeOutput(stdoutRedirect, process.cwd(), stdoutAppend);
    if (stderrRedirect) {
      fs.closeSync(fs.openSync(stderrRedirect, stderrAppend ? "a" : "w"));
    }
    rl.prompt();
    return;
  }

  if (cmd === "cd") {
    if (cmdArgs.length > 0) {
      const dir = cmdArgs[0];
      let targetDir;
      if (dir === "~") {
        targetDir = process.env.HOME || dir;
      } else if (dir.startsWith("/")) {
        targetDir = dir;
      } else {
        targetDir = path.resolve(process.cwd(), dir);
      }
      try {
        fs.accessSync(targetDir, fs.constants.F_OK);
        const stat = fs.statSync(targetDir);
        if (stat.isDirectory()) {
          process.chdir(targetDir);
        } else {
          writeError(stderrRedirect, `cd: ${dir}: No such file or directory`);
        }
      } catch (err) {
        writeError(stderrRedirect, `cd: ${dir}: No such file or directory`);
      }
    }
    rl.prompt();
    return;
  }

  if (cmd === "type") {
    if (cmdArgs.length > 0) {
      const target = cmdArgs[0];
      if (builtins.has(target)) {
        console.log(`${target} is a shell builtin`);
      } else {
        const resolved = findExecutable(target);
        if (resolved) {
          console.log(`${target} is ${resolved}`);
        } else {
          writeError(stderrRedirect, `${target}: not found`);
        }
      }
    }
    rl.prompt();
    return;
  }

  if (cmd === "complete") {
    // Support `complete -C <path> <command>` to register a completer script
    // and `complete -p <command>` to display the registered spec.
    if (cmdArgs.length >= 1) {
      const flag = cmdArgs[0];
      if (flag === "-C") {
        // register: cmdArgs[1] = path, cmdArgs[2] = command
        if (cmdArgs.length >= 3) {
          const scriptPath = cmdArgs[1];
          const targetCmd = cmdArgs[2];
          completionSpecs.set(targetCmd, { type: "C", path: scriptPath });
        }
        rl.prompt();
        return;
      }

      if (flag === "-r") {
        // remove a registered completion: cmdArgs[1] = command
        if (cmdArgs.length >= 2) {
          const targetCmd = cmdArgs[1];
          completionSpecs.delete(targetCmd);
        }
        rl.prompt();
        return;
      }

      if (flag === "-p") {
        if (cmdArgs.length >= 2) {
          const target = cmdArgs[1];
          const spec = completionSpecs.get(target);
          if (spec && spec.type === "C") {
            // normalized output: complete -C '<path>' <command>
            console.log(`complete -C '${spec.path}' ${target}`);
          } else {
            console.log(`complete: ${target}: no completion specification`);
          }
        }
        rl.prompt();
        return;
      }
    }

    rl.prompt();
    return;
  }

  if (cmd === "jobs") {
    // Empty implementation for now: no background jobs tracked yet
    rl.prompt();
    return;
  }

  const resolved = findExecutable(cmd);
  if (resolved) {
    if (runInBackground) {
      // Start process in background and do not wait
      const stdio = ["ignore", "ignore", "ignore"];
      let stdoutFd;
      let stderrFd;
      if (stdoutRedirect) {
        const stdoutFlag = stdoutAppend ? "a" : "w";
        stdoutFd = fs.openSync(stdoutRedirect, stdoutFlag);
        stdio[1] = stdoutFd;
      }
      if (stderrRedirect) {
        const stderrFlag = stderrAppend ? "a" : "w";
        stderrFd = fs.openSync(stderrRedirect, stderrFlag);
        stdio[2] = stderrFd;
      }

      const child = childProcess.spawn(resolved, cmdArgs, { stdio, detached: true, argv0: cmd });
      // Register job
      const jobId = nextJobId++;
      jobs.set(jobId, { pid: child.pid, cmd: args.join(" ") });
      console.log(`[${jobId}] ${child.pid}`);

      if (stdoutFd !== undefined) {
        fs.closeSync(stdoutFd);
      }
      if (stderrFd !== undefined) {
        fs.closeSync(stderrFd);
      }

      try {
        child.unref();
      } catch (e) {
        // ignore
      }

      rl.prompt();
      return;
    }

    const stdio = ["inherit", "inherit", "inherit"];
    let stdoutFd;
    let stderrFd;
    if (stdoutRedirect) {
      const stdoutFlag = stdoutAppend ? "a" : "w";
      stdoutFd = fs.openSync(stdoutRedirect, stdoutFlag);
      stdio[1] = stdoutFd;
    }
    if (stderrRedirect) {
      const stderrFlag = stderrAppend ? "a" : "w";
      stderrFd = fs.openSync(stderrRedirect, stderrFlag);
      stdio[2] = stderrFd;
    }

    const child = childProcess.spawn(resolved, cmdArgs, { stdio, argv0: cmd });
    child.on("close", () => {
      if (stdoutFd !== undefined) {
        fs.closeSync(stdoutFd);
      }
      if (stderrFd !== undefined) {
        fs.closeSync(stderrFd);
      }
      rl.prompt();
    });
    child.on("error", () => {
      if (stdoutFd !== undefined) {
        fs.closeSync(stdoutFd);
      }
      if (stderrFd !== undefined) {
        fs.closeSync(stderrFd);
      }
      console.log(`${cmd}: command not found`);
      rl.prompt();
    });
    return;
  }

  console.log(`${cmd}: command not found`);
  rl.prompt();
});
