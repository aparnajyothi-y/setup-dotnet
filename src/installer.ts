import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import * as hc from '@actions/http-client';
import {chmodSync} from 'fs';
import path from 'path';
import os from 'os';
import semver from 'semver';
import {IS_WINDOWS, PLATFORM} from './utils';
import {QualityOptions} from './setup-dotnet';

export interface DotnetVersion {
  type: string;
  value: string;
  qualityFlag: boolean;
}

const QUALITY_INPUT_MINIMAL_MAJOR_TAG = 6;
const LATEST_PATCH_SYNTAX_MINIMAL_MAJOR_TAG = 5;

export class DotnetVersionResolver {
  private inputVersion: string;
  private resolvedArgument: DotnetVersion;

  constructor(version: string) {
    this.inputVersion = version.trim();
    this.resolvedArgument = {type: '', value: '', qualityFlag: false};
  }

  private async resolveVersionInput(): Promise<void> {
    if (!semver.validRange(this.inputVersion) && !this.isLatestPatchSyntax()) {
      throw new Error(
        `The 'dotnet-version' was supplied in invalid format: ${this.inputVersion}! Supported syntax: A.B.C, A.B, A.B.x, A, A.x, A.B.Cxx`
      );
    }
    if (semver.valid(this.inputVersion)) {
      this.createVersionArgument();
    } else {
      await this.createChannelArgument();
    }
  }

  private isNumericTag(versionTag): boolean {
    return /^\d+$/.test(versionTag);
  }

  private isLatestPatchSyntax() {
    const majorTag = this.inputVersion.match(
      /^(?<majorTag>\d+)\.\d+\.\d{1}x{2}$/
    )?.groups?.majorTag;
    if (
      majorTag &&
      parseInt(majorTag) < LATEST_PATCH_SYNTAX_MINIMAL_MAJOR_TAG
    ) {
      throw new Error(
        `The 'dotnet-version' was supplied in invalid format: ${this.inputVersion}! The A.B.Cxx syntax is available since the .NET 5.0 release.`
      );
    }
    return Boolean(majorTag);
  }

  private createVersionArgument() {
    this.resolvedArgument.type = 'version';
    this.resolvedArgument.value = this.inputVersion;
  }

  private async createChannelArgument() {
    this.resolvedArgument.type = 'channel';
    const [major, minor] = this.inputVersion.split('.');
    if (this.isLatestPatchSyntax()) {
      this.resolvedArgument.value = this.inputVersion;
    } else if (this.isNumericTag(major) && this.isNumericTag(minor)) {
      this.resolvedArgument.value = `${major}.${minor}`;
    } else if (this.isNumericTag(major)) {
      this.resolvedArgument.value = await this.getLatestByMajorTag(major);
    } else {
      this.resolvedArgument.value = 'LTS';
    }
    this.resolvedArgument.qualityFlag =
      parseInt(major) >= QUALITY_INPUT_MINIMAL_MAJOR_TAG;
  }

  public async createDotnetVersion(): Promise<DotnetVersion> {
    await this.resolveVersionInput();
    if (!this.resolvedArgument.type) {
      return this.resolvedArgument;
    }
    this.resolvedArgument.type = IS_WINDOWS
      ? this.resolvedArgument.type === 'channel'
        ? '-Channel'
        : '-Version'
      : this.resolvedArgument.type === 'channel'
        ? '--channel'
        : '--version';
    return this.resolvedArgument;
  }

  private async getLatestByMajorTag(majorTag: string): Promise<string> {
    const httpClient = new hc.HttpClient('actions/setup-dotnet', [], {
      allowRetries: true,
      maxRetries: 3
    });
    const response = await httpClient.getJson<any>(
      DotnetVersionResolver.DotnetCoreIndexUrl
    );
    const result = response.result || {};
    const releasesInfo: any[] = result['releases-index'];

    const releaseInfo = releasesInfo.find(info => {
      const sdkParts: string[] = info['channel-version'].split('.');
      return sdkParts[0] === majorTag;
    });

    if (!releaseInfo) {
      throw new Error(
        `Could not find info for version with major tag: "${majorTag}" at ${DotnetVersionResolver.DotnetCoreIndexUrl}`
      );
    }

    return releaseInfo['channel-version'];
  }

  static DotnetCoreIndexUrl =
    'https://dotnetcli.azureedge.net/dotnet/release-metadata/releases-index.json';
}

// Utility function to wrap paths containing spaces in quotes
function quotePathIfNeeded(filePath: string): string {
  return filePath.includes(' ') ? `"${filePath}"` : filePath;
}

export class DotnetInstallScript {
  private scriptName = IS_WINDOWS ? 'install-dotnet.ps1' : 'install-dotnet.sh';
  private escapedScript: string;
  private scriptArguments: string[] = [];

  constructor() {
    this.escapedScript = quotePathIfNeeded(
      path.join(__dirname, '..', '..', 'externals', this.scriptName)
    ).replace(/'/g, "''");

    if (IS_WINDOWS) {
      this.setupScriptPowershell();
      return;
    }

    this.setupScriptBash();
  }

  private setupScriptPowershell() {
    this.scriptArguments = [
      '-NoLogo',
      '-Sta',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Unrestricted',
      '-Command'
    ];

    this.scriptArguments.push('&', `'${this.escapedScript}'`);

    if (process.env['https_proxy'] != null) {
      this.scriptArguments.push(`-ProxyAddress ${process.env['https_proxy']}`);
    }
    if (process.env['no_proxy'] != null) {
      this.scriptArguments.push(`-ProxyBypassList ${process.env['no_proxy']}`);
    }
  }

  private setupScriptBash() {
    chmodSync(this.escapedScript, '777');
  }

  private async getScriptPath() {
    if (IS_WINDOWS) {
      return (await io.which('pwsh', false)) || io.which('powershell', true);
    }

    return io.which(this.escapedScript, true);
  }

  public useArguments(...args: string[]) {
    this.scriptArguments.push(...args);
    return this;
  }

  public useVersion(dotnetVersion: DotnetVersion, quality?: QualityOptions) {
    if (dotnetVersion.type) {
      this.useArguments(dotnetVersion.type, dotnetVersion.value);
    }

    if (quality && !dotnetVersion.qualityFlag) {
      core.warning(
        `The 'dotnet-quality' input can be used only with .NET SDK version in A.B, A.B.x, A, A.x and A.B.Cxx formats where the major tag is higher than 5. You specified: ${dotnetVersion.value}. 'dotnet-quality' input is ignored.`
      );
      return this;
    }

    if (quality) {
      this.useArguments(IS_WINDOWS ? '-Quality' : '--quality', quality);
    }

    return this;
  }

  public async execute() {
    const getExecOutputOptions = {
      ignoreReturnCode: true,
      env: process.env as {[key: string]: string}
    };

    return exec.getExecOutput(
      `${await this.getScriptPath()}`,
      this.scriptArguments,
      getExecOutputOptions
    );
  }
}

export abstract class DotnetInstallDir {
  private static readonly default = {
    linux: '/usr/share/dotnet',
    mac: path.join(process.env['HOME'] || '', '.dotnet'),
    windows: path.join(process.env['PROGRAMFILES'] || '', 'dotnet')
  };

  public static readonly dirPath = process.env['DOTNET_INSTALL_DIR']
    ? DotnetInstallDir.convertInstallPathToAbsolute(
        process.env['DOTNET_INSTALL_DIR']
      )
    : DotnetInstallDir.default[PLATFORM];

  private static convertInstallPathToAbsolute(installDir: string): string {
    if (path.isAbsolute(installDir)) return path.normalize(installDir);

    const transformedPath = installDir.startsWith('~')
      ? path.join(os.homedir(), installDir.slice(1))
      : path.join(process.cwd(), installDir);

    return path.normalize(transformedPath);
  }

  public static addToPath() {
    core.addPath(process.env['DOTNET_INSTALL_DIR']!);
    core.exportVariable('DOTNET_ROOT', process.env['DOTNET_INSTALL_DIR']);
  }

  public static setEnvironmentVariable() {
    process.env['DOTNET_INSTALL_DIR'] = DotnetInstallDir.dirPath;
  }
}

export class DotnetCoreInstaller {
  static {
    DotnetInstallDir.setEnvironmentVariable();
  }

  constructor(
    private version: string,
    private quality: QualityOptions
  ) {}

  public async installDotnet(): Promise<string | null> {
    const versionResolver = new DotnetVersionResolver(this.version);
    const dotnetVersion = await versionResolver.createDotnetVersion();

    // Install dotnet runtime first to make sure the path is set
    const installScript = new DotnetInstallScript().useVersion(
      dotnetVersion,
      this.quality
    );
    const installResult = await installScript.execute();

    if (installResult.exitCode !== 0) {
      throw new Error(`Failed to install .NET SDK: ${installResult.stderr}`);
    }

    return dotnetVersion.value;
  }
}

// Other classes follow...
