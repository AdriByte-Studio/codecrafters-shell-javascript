const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const readline = require("readline");
const stream = require("stream");

const completions = ["echo", "exit", "history"];
const history = [];

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
const jobs = new Map();

function allocateJobId() {
  if (jobs.size === 0) return 1;
  const ids = Array.from(jobs.keys()).map((k) => Number(k));
  const max = Math.max(...ids);
  return max + 1;
}

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

function reapJobs() {
  const entries = Array.from(jobs.entries());
  if (entries.length === 0) return;
  const lastIndex = entries.length - 1;
  for (let i = 0; i < entries.length; i += 1) {
    const [jobId, info] = entries[i];
    let isRunning = true;
    try {
      process.kill(info.pid, 0);
    } catch (err) {
      isRunning = false;
    }
    if (!isRunning) {
      let marker = " ";
      if (i === lastIndex) marker = "+";
      else if (i === lastIndex - 1) marker = "-";
      const status = "Done";
      const paddedStatus = status + "".padEnd(24 - status.length, " ");
      console.log(`[${jobId}]${marker}  ${paddedStatus}${info.cmd}`);
      jobs.delete(jobId);
    }
  }
}

function prompt() {
  try {
    reapJobs();
  } catch (e) {
    // ignore reaping errors
  }
  rl.prompt();
}

const builtins = new Set(["echo", "exit", "type", "pwd", "cd", "complete", "jobs", "history"]);

function executeBuiltin(argv, { stdoutStream = process.stdout, stderrStream = process.stderr } = {}) {
  const name = argv[0];
  const args = argv.slice(1);
  if (name === "echo") {
    const text = args.join(" ");
    try {
      stdoutStream.write(text + "\n");
    } catch (e) {
      // ignore
    }
    return 0;
  }

  if (name === "type") {
    if (args.length > 0) {
      const target = args[0];
      if (builtins.has(target)) {
        stdoutStream.write(`${target} is a shell builtin\n`);
      } else {
        const resolved = findExecutable(target);
        if (resolved) {
          stdoutStream.write(`${target} is ${resolved}\n`);
        } else {
          stderrStream.write(`${target}: not found\n`);
          return 1;
        }
      }
    }
    return 0;
  }

  if (name === "pwd") {
    stdoutStream.write(process.cwd() + "\n");
    return 0;
  }

  if (name === "cd") {
    if (args.length > 0) {
      const dir = args[0];
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
          stderrStream.write(`cd: ${dir}: No such file or directory\n`);
          return 1;
        }
      } catch (err) {
        stderrStream.write(`cd: ${dir}: No such file or directory\n`);
        return 1;
      }
    }
    return 0;
  }

  if (name === "jobs") {
    // simple jobs output to provided stdoutStream
    const entries = Array.from(jobs.entries());
    if (entries.length > 0) {
      const lastIndex = entries.length - 1;
      for (let i = 0; i < entries.length; i += 1) {
        const [jobId, info] = entries[i];
        let marker = " ";
        if (i === lastIndex) marker = "+";
        else if (i === lastIndex - 1) marker = "-";
        let isRunning = true;
        try { process.kill(info.pid, 0); } catch (e) { isRunning = false; }
        const status = isRunning ? "Running" : "Done";
        const paddedStatus = status + "".padEnd(24 - status.length, " ");
        stdoutStream.write(`[${jobId}]${marker}  ${paddedStatus}${info.cmd}${isRunning ? ' &' : ''}\n`);
      }
    }
    return 0;
  }

  if (name === "history") {
    for (let i = 0; i < history.length; i += 1) {
      stdoutStream.write(`${String(i + 1).padStart(5)}  ${history[i]}\n`);
    }
    return 0;
  }

  return 127;
}

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

function splitUnquoted(line, sep) {
  const parts = [];
  let current = "";
  let quote = null;
  let escapeNext = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (escapeNext) {
      current += ch;
      escapeNext = false;
      continue;
    }
    if (ch === "\\") {
      escapeNext = true;
      current += ch;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === sep) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function stripTrailingUnquotedAmp(line) {
  let quote = null;
  let escapeNext = false;
  for (let i = line.length - 1; i >= 0; i -= 1) {
    const ch = line[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === "\\") {
      escapeNext = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '&') {
      const before = line.slice(0, i).trimEnd();
      return { line: before, hadAmp: true };
    }
    if (!/\s/.test(ch)) {
      break;
    }
  }
  return { line, hadAmp: false };
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

prompt();

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
    prompt();
    return;
  }

  history.push(trimmed);
  const { args, stdoutRedirect, stdoutAppend, stderrRedirect, stderrAppend } = parseCommandLine(line);
  if (args.length === 0) {
    prompt();
    return;
  }

  const { line: strippedLine, hadAmp } = stripTrailingUnquotedAmp(line);
  const pipelineParts = splitUnquoted(strippedLine, '|').map((s) => s.trim());
  const pipelineMode = pipelineParts.length > 1;
  if (pipelineMode) {
    const stages = pipelineParts.map((part) => parseCommandLine(part));
    if (stages.some((stage) => stage.args.length === 0)) {
      prompt();
      return;
    }

    const externalChildren = [];
    let prevOutput = null;
    let lastChild = null;
    let lastStageIsBuiltin = false;
    let activeExternal = 0;
    let completedExternal = 0;
    let prompted = false;

    const maybePrompt = () => {
      if (!prompted) {
        prompted = true;
        prompt();
      }
    };

    const onExternalClose = () => {
      completedExternal += 1;
      if (completedExternal === activeExternal) {
        maybePrompt();
      }
    };

    const onExternalError = () => {
      maybePrompt();
    };

    for (let i = 0; i < stages.length; i += 1) {
      const stage = stages[i];
      const cmd = stage.args[0];
      const isBuiltin = builtins.has(cmd);
      const isLast = i === stages.length - 1;

      if (isBuiltin) {
        const stdoutStream = isLast ? process.stdout : new stream.PassThrough();
        executeBuiltin(stage.args, { stdoutStream, stderrStream: process.stderr });
        if (!isLast) {
          stdoutStream.end();
        }
        prevOutput = stdoutStream;
        lastStageIsBuiltin = true;
        continue;
      }

      const resolved = findExecutable(cmd);
      if (!resolved) {
        console.log(`${cmd}: command not found`);
        prompt();
        return;
      }

      const stdio = [prevOutput ? 'pipe' : 'inherit', isLast ? 'inherit' : 'pipe', 'inherit'];
      const child = childProcess.spawn(resolved, stage.args.slice(1), { stdio, argv0: cmd });
      externalChildren.push(child);
      activeExternal += 1;
      lastChild = child;
      lastStageIsBuiltin = false;

      if (prevOutput && child.stdin) {
        prevOutput.pipe(child.stdin);
      }
      if (!isLast) {
        prevOutput = child.stdout;
      }

      child.on('close', onExternalClose);
      child.on('error', onExternalError);
    }

    if (hadAmp) {
      if (!lastStageIsBuiltin && lastChild) {
        const jobId = allocateJobId();
        const info = {
          pid: lastChild.pid,
          cmd: stages.map((stage) => stage.args.join(' ')).join(' | '),
          child: lastChild,
          status: 'Running',
        };
        jobs.set(jobId, info);
        lastChild.on('exit', () => {
          info.status = 'Done';
        });
        console.log(`[${jobId}] ${lastChild.pid}`);
      }
      prompt();
      return;
    }

    if (activeExternal > 0) {
      return;
    }

    prompt();
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
    prompt();
    return;
  }

  if (cmd === "pwd") {
    writeOutput(stdoutRedirect, process.cwd(), stdoutAppend);
    if (stderrRedirect) {
      fs.closeSync(fs.openSync(stderrRedirect, stderrAppend ? "a" : "w"));
    }
    prompt();
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
    prompt();
    return;
  }

  if (cmd === "history") {
    for (let i = 0; i < history.length; i += 1) {
      console.log(`${String(i + 1).padStart(5)}  ${history[i]}`);
    }
    prompt();
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
    prompt();
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
        prompt();
        return;
      }

      if (flag === "-r") {
        // remove a registered completion: cmdArgs[1] = command
        if (cmdArgs.length >= 2) {
          const targetCmd = cmdArgs[1];
          completionSpecs.delete(targetCmd);
        }
        prompt();
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
        prompt();
        return;
      }
    }

    prompt();
    return;
  }

  if (cmd === "jobs") {
    // List background jobs. For this stage we only need to list running jobs tracked in `jobs`.
    // Format: [1]+  Running                 sleep 10 &
    const entries = Array.from(jobs.entries());
    if (entries.length > 0) {
      // The most recent job is the last one inserted
      const lastIndex = entries.length - 1;
      for (let i = 0; i < entries.length; i += 1) {
        const [jobId, info] = entries[i];
        let marker = " ";
        if (i === lastIndex) marker = "+";
        else if (i === lastIndex - 1) marker = "-";

        // Check if process still exists. If not, mark Done and remove.
        let isRunning = true;
        try {
          process.kill(info.pid, 0);
        } catch (err) {
          isRunning = false;
        }

        if (isRunning) {
          const status = "Running";
          const paddedStatus = status + "".padEnd(24 - status.length, " ");
          console.log(`[${jobId}]${marker}  ${paddedStatus}${info.cmd} &`);
        } else {
          const status = "Done";
          const paddedStatus = status + "".padEnd(24 - status.length, " ");
          console.log(`[${jobId}]${marker}  ${paddedStatus}${info.cmd}`);
          jobs.delete(jobId);
        }
      }
    }
    rl.prompt();
    return;
  }

  const resolved = findExecutable(cmd);
  if (resolved) {
    if (runInBackground) {
      // Start process in background and do not wait.
      // Background jobs should share the shell's stdout/stderr so their output appears.
      const stdio = ["ignore", "inherit", "inherit"];
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
      // Register job with status and keep child for exit handling
      const jobId = allocateJobId();
      const info = { pid: child.pid, cmd: args.join(" "), child, status: "Running" };
      jobs.set(jobId, info);
      child.on("exit", () => {
        info.status = "Done";
      });
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

      prompt();
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
      prompt();
    });
    child.on("error", () => {
      if (stdoutFd !== undefined) {
        fs.closeSync(stdoutFd);
      }
      if (stderrFd !== undefined) {
        fs.closeSync(stderrFd);
      }
      console.log(`${cmd}: command not found`);
      prompt();
    });
    return;
  }

  console.log(`${cmd}: command not found`);
  prompt();
});
