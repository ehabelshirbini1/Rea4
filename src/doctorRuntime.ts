import {
  systemDoctorHost,
  type DoctorCheck,
  type DoctorHost,
} from "./application/Doctor.js";
import { fileURLToPath } from "node:url";
import { inspectJadxProvider } from "./android/JadxDoctor.js";
import { inspectSystemGhidraProvider } from "./ghidra/GhidraDoctor.js";
import { inspectIdaRegistration } from "./ida/IdaDoctor.js";
import { inspectKunaProvider } from "./kuna/KunaDoctor.js";
import { readIdaConfiguration } from "./ida/IdaConfiguration.js";
import { parseJebMcpEndpoint } from "./jeb/JebMcpEndpoint.js";
import { selectLinuxPrivateDisplayStrategy } from "./hopper/LinuxPrivateDisplayProbe.js";
import { ok } from "./domain/result.js";
import {
  linuxHopperEmbeddedPythonPackage,
  readLinuxDistribution,
} from "./application/LinuxHopper.js";
import { execFileOutput } from "./process/ExecFileOutput.js";

/** Compose provider diagnostics at the outer CLI adapter boundary. */
export const createSystemDoctorHost = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  signal?: AbortSignal,
): DoctorHost => {
  const selectedJebEndpoint = environment.REA_JEB_MCP_URL;
  const selectedJebRegistrationEnvironment: Readonly<Record<string, string>> =
    selectedJebEndpoint !== undefined &&
    selectedJebEndpoint.length > 0 &&
    parseJebMcpEndpoint(selectedJebEndpoint).ok
      ? { REA_JEB_MCP_URL: selectedJebEndpoint }
      : {};
  return systemDoctorHost({
    environment,
    ...(signal === undefined ? {} : { signal }),
    providerRegistrationEnvironment: () => selectedJebRegistrationEnvironment,
    resolveProviderRequestBudget: (
      analysisProvider,
      registrationEnvironment,
    ) => {
      if (analysisProvider !== "ida" && analysisProvider !== "auto")
        return ok(undefined);
      const path = registrationEnvironment.REA_IDA_MCP_CONFIG;
      if (path === undefined) return ok(undefined);
      const registration = readIdaConfiguration(path);
      if (registration.ok) return ok(registration.value.timeoutMs);
      // An invalid IDA registration cannot be selected automatically. Keep it
      // out of recommendations for another available provider, but surface the
      // parser-owned error when IDA itself was explicitly selected.
      return analysisProvider === "ida" ? registration : ok(undefined);
    },
    providerInspections: async (fileCloseResources, inspectionSignal) => [
      await inspectSystemGhidraProvider(
        environment,
        fileCloseResources,
        inspectionSignal,
      ),
      inspectIdaRegistration(environment.REA_IDA_MCP_CONFIG),
      await inspectJadxProvider(
        environment,
        fileCloseResources,
        inspectionSignal,
      ),
      await inspectKunaProvider(environment, process.platform, {
        fileCloseResources,
      }),
    ],
    linuxDemoRuntimeCheck: () => inspectLinuxPrivateDisplay(environment),
    linuxEmbeddedPythonRuntimeCheck: () =>
      inspectLinuxEmbeddedPythonRuntime(environment),
  });
};

export const inspectLinuxEmbeddedPythonRuntime = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  readDistribution: () => Promise<
    Awaited<ReturnType<typeof readLinuxDistribution>>
  > = readLinuxDistribution,
  run: typeof execFileOutput = execFileOutput,
): Promise<DoctorCheck> => {
  const distribution = await readDistribution();
  const packageName = linuxHopperEmbeddedPythonPackage(distribution);
  if (packageName === undefined)
    return {
      name: "hopper-embedded-python",
      ok: true,
      classification: "healthy",
      detail: `${distribution?.id ?? "unknown"} ${distribution?.versionId ?? "unknown"} has no verified fixed Python ABI package`,
    };
  try {
    const linked = await run("ldconfig", ["-p"], {
      env: environment,
    });
    const available = /\blibpython3\.12\.so\.1\.0\b/u.test(linked.stdout);
    return {
      name: "hopper-embedded-python",
      ok: available,
      classification: available ? "healthy" : "missing_dependency",
      detail: `${packageName} (${available ? "available" : "missing"})`,
      ...(available
        ? {}
        : {
            remediation: `Install ${packageName}, then rerun rea doctor --provider hopper.`,
          }),
    };
  } catch (cause: unknown) {
    return {
      name: "hopper-embedded-python",
      ok: false,
      classification: "unknown",
      detail: cause instanceof Error ? cause.message : String(cause),
      remediation:
        "Verify the matching Hopper embedded Python runtime with ldconfig, then rerun rea doctor --provider hopper.",
    };
  }
};

const HOPPER_DEMO_HELPER_PATH = fileURLToPath(
  new URL("../scripts/hopper-demo-x11.py", import.meta.url),
);

const inspectLinuxPrivateDisplay = async (
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<DoctorCheck> => {
  const selection = await selectLinuxPrivateDisplayStrategy({
    helperPath: HOPPER_DEMO_HELPER_PATH,
    environment,
  });
  const value = selection.diagnostic;
  const detail = [
    `strategy=${selection.strategy}`,
    `socket_directory=${value.socket_directory}`,
    `mode=${value.socket_directory_mode ?? "unknown"}`,
    `mount_read_only=${String(value.mount_read_only)}`,
    `effective_mode=${value.effective_socket_directory_mode ?? "unknown"}`,
    `effective_mount_read_only=${String(value.effective_mount_read_only)}`,
    `wsl=${String(value.wsl)}`,
  ].join("; ");
  if (selection.ok)
    return {
      name: "hopper-demo-runtime",
      ok: true,
      classification: "healthy",
      detail,
      details: { private_display: { ...value } },
    };
  const missingDependency =
    value.failure_code === "runtime_dependency_unavailable" ||
    value.failure_code === "x11_authorization_failed";
  return {
    name: "hopper-demo-runtime",
    ok: false,
    classification: missingDependency ? "missing_dependency" : "config_drift",
    detail,
    details: { private_display: { ...value } },
    remediation:
      value.failure_code === "x11_socket_directory_unusable"
        ? "Enable unprivileged user and mount namespaces, or provide a writable mode-1777 /tmp/.X11-unix directory. Do not mutate the current host mount with sudo; then rerun rea doctor --provider hopper."
        : missingDependency
          ? "Install Xvfb, xauth, Python 3, the matching Hopper 6.6 embedded Python 3.12 runtime (libpython3.12t64 on Ubuntu 24.04 or python3.12-libs on Fedora 41), libX11, and libXtst, then rerun rea doctor --provider hopper."
          : "Inspect the private-display diagnostic, correct the reported local condition, and rerun rea doctor --provider hopper.",
  };
};
