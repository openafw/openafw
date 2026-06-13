// Service-definition templates for macOS launchd and Linux systemd.
// No actual fs / spawn here — pure string rendering for testability.

export function launchdPlist(opts: {
  label: string
  programArguments: string[]
  agentfwHome: string
  logPath: string
  errPath: string
}): string {
  const args = opts.programArguments
    .map((a) => `        <string>${escapeXml(a)}</string>`)
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(opts.label)}</string>

    <key>ProgramArguments</key>
    <array>
${args}
    </array>

    <key>RunAtLoad</key><true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key><false/>
        <key>Crashed</key><true/>
    </dict>

    <key>StandardOutPath</key>
    <string>${escapeXml(opts.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(opts.errPath)}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>AGENTFW_HOME</key>
        <string>${escapeXml(opts.agentfwHome)}</string>
    </dict>

    <key>ProcessType</key>
    <string>Background</string>

    <key>ThrottleInterval</key><integer>10</integer>
</dict>
</plist>
`
}

export function systemdUnit(opts: {
  description: string
  execStart: string[]
  agentfwHome: string
  logPath: string
  errPath: string
}): string {
  const cmd = opts.execStart.map(quoteShell).join(' ')
  return `[Unit]
Description=${opts.description}
After=network-online.target

[Service]
Type=simple
ExecStart=${cmd}
Restart=on-failure
RestartSec=10
Environment=AGENTFW_HOME=${opts.agentfwHome}
StandardOutput=append:${opts.logPath}
StandardError=append:${opts.errPath}

[Install]
WantedBy=default.target
`
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function quoteShell(s: string): string {
  if (/^[a-zA-Z0-9_\-./]+$/.test(s)) return s
  return `'${s.replace(/'/g, "'\\''")}'`
}
