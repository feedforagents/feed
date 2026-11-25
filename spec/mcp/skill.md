# Canonical SKILL.md publication, SHA-256 authority, and host links

Feed publishes one canonical agent skill from a single source (PRD §10), generating `/SKILL.md`, `/.well-known/agent-skills/feed/SKILL.md`, `/.well-known/agent-skills/index.json` (with SHA-256 digest), `/llms.txt`, `/how-to-play.md`, and host plugin bundles (`OpenAI`, `Claude`, `OpenClaw`, `Hermes`). Modeled after `slop.cash`'s skill authority and validation specs (`skillAuthority.md`, `skillValidation.md`, `skillRendering.md`), clients and installers admit downloaded skill bytes only from HTTPS `feed.fun` origins matching the `index.json` SHA-256 digest and passing package validation, while the Join sheet gates deep links for all 9 agent hosts on device verification.

## Story: Generate, verify, and serve Feed's canonical skill and one-click host launchers

> As an agent user or installer, I want `/SKILL.md`, `llms.txt`, `how-to-play.md`, and `/.well-known/agent-skills/` generated from one verified source with matching SHA-256 digests and HTTPS origin authority, and Join-sheet deep links gated by device verification.

### One canonical source renders all discovery documents and `index.json` SHA-256 digests

```quint
type SkillOrigin =
  | OriginFeedHttps
  | OriginWellKnownHttps
  | OriginHttpInsecure
  | OriginFixtureFile
  | OriginExternalRedirect

type AdmissionStatus =
  | AdmissionIdle
  | AdmissionFetching
  | AdmissionDownloaded
  | AdmissionAdmitted
  | AdmissionRefused

type SkillRefusal =
  | RefusalNone
  | RefusalInvalidOrigin
  | RefusalDigestMismatch
  | RefusalInvalidPackage
  | RefusalPolicyViolation

type AgentHost =
  | HostChatGPT
  | HostClaude
  | HostGemini
  | HostGrok
  | HostPerplexity
  | HostMuse
  | HostHermes
  | HostOpenClaw
  | HostCursor

type LaunchKind =
  | PromptDeepLink
  | PastePromptOnly
  | CliOrSchemeInstall
  | CopyPromptFallback

type DirectoryPolicy =
  | DirectoryListedAtLaunch
  | DirectoryHeldFor18Plus
  | CustomConnectorOnly

type SkillPolicy = {
  neverAskPhoneOrCode: bool,
  noPurchaseLinksOrUpsell: bool,
  respectsSocialMode: bool,
  virtualPointsDisclaimer: bool,
}

type CanonicalSource = {
  sourceCommit: str,
  sourceDigest: str,
  mcpUrl: str,
  sourcePolicy: SkillPolicy,
}

type PublishedBundle = {
  isPublished: bool,
  rootSkillDigest: str,
  wellKnownSkillDigest: str,
  indexSha256: str,
  indexUrl: str,
  llmsTxtSourceDigest: str,
  howToPlaySourceDigest: str,
  pluginBundleDigest: str,
}

type PackageCheck = {
  realDirectory: bool,
  boundedFiles: bool,
  validYamlFrontmatter: bool,
}

type SkillEffect =
  | PublishedBundleEmitted({ publishedSha256: str })
  | SkillAdmittedEffect({ admittedSha256: str, admittedOrigin: SkillOrigin })
  | SkillRefusedEffect({ refusedWith: SkillRefusal })

type SkillPublisher = {
  canonical: CanonicalSource,
  published: PublishedBundle,
  fetchOrigin: SkillOrigin,
  sameOrigin: bool,
  downloadedSha256: str,
  downloadedPolicy: SkillPolicy,
  packageCheck: PackageCheck,
  admissionStatus: AdmissionStatus,
  lastRefusal: SkillRefusal,
  verifiedHosts: List[AgentHost],
}

type SkillStep = {
  state: SkillPublisher,
  out: List[SkillEffect],
}

pure val canonicalMcpUrl: str = "https://feed.fun/mcp"
pure val canonicalWellKnownSkillUrl: str = "https://feed.fun/.well-known/agent-skills/feed/SKILL.md"

pure val cleanPolicy: SkillPolicy = {
  neverAskPhoneOrCode: true,
  noPurchaseLinksOrUpsell: true,
  respectsSocialMode: true,
  virtualPointsDisclaimer: true,
}

pure val emptyPolicy: SkillPolicy = {
  neverAskPhoneOrCode: false,
  noPurchaseLinksOrUpsell: false,
  respectsSocialMode: false,
  virtualPointsDisclaimer: false,
}

pure val emptySource: CanonicalSource = {
  sourceCommit: "",
  sourceDigest: "",
  mcpUrl: "",
  sourcePolicy: emptyPolicy,
}

pure val emptyBundle: PublishedBundle = {
  isPublished: false,
  rootSkillDigest: "",
  wellKnownSkillDigest: "",
  indexSha256: "",
  indexUrl: "",
  llmsTxtSourceDigest: "",
  howToPlaySourceDigest: "",
  pluginBundleDigest: "",
}

pure val uncheckedPackage: PackageCheck = {
  realDirectory: false,
  boundedFiles: false,
  validYamlFrontmatter: false,
}

pure val initial: SkillPublisher = {
  canonical: emptySource,
  published: emptyBundle,
  fetchOrigin: OriginExternalRedirect,
  sameOrigin: false,
  downloadedSha256: "",
  downloadedPolicy: emptyPolicy,
  packageCheck: uncheckedPackage,
  admissionStatus: AdmissionIdle,
  lastRefusal: RefusalNone,
  verifiedHosts: List(),
}

pure def policyClean(p: SkillPolicy): bool =
  p.neverAskPhoneOrCode
    and p.noPurchaseLinksOrUpsell
    and p.respectsSocialMode
    and p.virtualPointsDisclaimer

pure def packageValid(pkg: PackageCheck): bool =
  pkg.realDirectory and pkg.boundedFiles and pkg.validYamlFrontmatter

pure def isProductionOrigin(origin: SkillOrigin): bool =
  origin == OriginFeedHttps or origin == OriginWellKnownHttps

pure def sourceValid(src: CanonicalSource): bool =
  src.sourceCommit != ""
    and src.sourceDigest != ""
    and src.mcpUrl == canonicalMcpUrl
    and policyClean(src.sourcePolicy)

pure def canPublishSkillBundle(s: SkillPublisher, source: CanonicalSource): bool =
  sourceValid(source)

pure def publishSkillBundle(s: SkillPublisher, source: CanonicalSource): SkillStep =
  {
    state: {
      ...s,
      canonical: source,
      published: {
        isPublished: true,
        rootSkillDigest: source.sourceDigest,
        wellKnownSkillDigest: source.sourceDigest,
        indexSha256: source.sourceDigest,
        indexUrl: canonicalWellKnownSkillUrl,
        llmsTxtSourceDigest: source.sourceDigest,
        howToPlaySourceDigest: source.sourceDigest,
        pluginBundleDigest: source.sourceDigest,
      },
      fetchOrigin: OriginExternalRedirect,
      sameOrigin: false,
      downloadedSha256: "",
      downloadedPolicy: emptyPolicy,
      packageCheck: uncheckedPackage,
      admissionStatus: AdmissionIdle,
      lastRefusal: RefusalNone,
    },
    out: List(PublishedBundleEmitted({ publishedSha256: source.sourceDigest })),
  }
```

### Downloaded skill bytes require HTTPS `feed.fun` origin authority, matching SHA-256 digest, and valid package structure

Insecure HTTP, `file://` fixtures, cross-origin redirects, SHA-256 mismatches against `/.well-known/agent-skills/index.json`, symlinks/oversized trees/invalid YAML, and policy violations (D-15/D-30 global no-purchase/no-refill policy or phone/code requests) are refused before admission. Every player starts with a fixed `100 pts` (`$100` virtual capital) grant with no buying, selling, or refilling capital on web or MCP.

```quint
pure def canFetchSkill(s: SkillPublisher, origin: SkillOrigin, sameOrigin: bool): bool =
  s.published.isPublished

pure def fetchSkill(s: SkillPublisher, origin: SkillOrigin, sameOrigin: bool): SkillStep =
  if (isProductionOrigin(origin) and sameOrigin)
    {
      state: {
        ...s,
        fetchOrigin: origin,
        sameOrigin: true,
        downloadedSha256: "",
        downloadedPolicy: emptyPolicy,
        packageCheck: uncheckedPackage,
        admissionStatus: AdmissionFetching,
        lastRefusal: RefusalNone,
      },
      out: List(),
    }
  else
    {
      state: {
        ...s,
        fetchOrigin: origin,
        sameOrigin: sameOrigin,
        downloadedSha256: "",
        downloadedPolicy: emptyPolicy,
        packageCheck: uncheckedPackage,
        admissionStatus: AdmissionRefused,
        lastRefusal: RefusalInvalidOrigin,
      },
      out: List(SkillRefusedEffect({ refusedWith: RefusalInvalidOrigin })),
    }

pure def canCompleteDownload(
  s: SkillPublisher,
  downloadedSha256: str,
  downloadedPolicy: SkillPolicy,
  pkgCheck: PackageCheck
): bool =
  s.admissionStatus == AdmissionFetching

pure def completeDownload(
  s: SkillPublisher,
  downloadedSha256: str,
  downloadedPolicy: SkillPolicy,
  pkgCheck: PackageCheck
): SkillStep =
  {
    state: {
      ...s,
      downloadedSha256: downloadedSha256,
      downloadedPolicy: downloadedPolicy,
      packageCheck: pkgCheck,
      admissionStatus: AdmissionDownloaded,
    },
    out: List(),
  }

pure def admissionRefusalReason(s: SkillPublisher): SkillRefusal =
  if (not(s.published.isPublished) or not(isProductionOrigin(s.fetchOrigin)) or not(s.sameOrigin))
    RefusalInvalidOrigin
  else if (s.downloadedSha256 == "" or s.downloadedSha256 != s.published.indexSha256)
    RefusalDigestMismatch
  else if (not(packageValid(s.packageCheck)))
    RefusalInvalidPackage
  else if (not(policyClean(s.downloadedPolicy)))
    RefusalPolicyViolation
  else
    RefusalNone

pure def canVerifyAndAdmitSkill(s: SkillPublisher): bool =
  s.admissionStatus == AdmissionDownloaded

pure def verifyAndAdmitSkill(s: SkillPublisher): SkillStep =
  val reason = admissionRefusalReason(s)
  if (reason == RefusalNone)
    {
      state: {
        ...s,
        admissionStatus: AdmissionAdmitted,
        lastRefusal: RefusalNone,
      },
      out: List(SkillAdmittedEffect({ admittedSha256: s.downloadedSha256, admittedOrigin: s.fetchOrigin })),
    }
  else
    {
      state: {
        ...s,
        admissionStatus: AdmissionRefused,
        lastRefusal: reason,
      },
      out: List(SkillRefusedEffect({ refusedWith: reason })),
    }
```

### All 9 Join-sheet host launchers degrade to copy-prompt until device-verified

Feed covers `ChatGPT`, `Claude`, `Gemini`, `Grok`, `Perplexity`, `Muse`, `Hermes`, `OpenClaw`, and `Cursor` (PRD §10). `Claude` (Connectors Directory + plugin bundle), `Muse` (Meta Connector Platform, D-22), and `OpenClaw` (ClawHub skill) target launch directories (D-31); `ChatGPT` holds directory submission until OpenAI ships 18+ plugin support (D-33). Any host whose deep link has not passed real-device verification shows `CopyPromptFallback` only.

```quint
pure def defaultHostLaunchKind(host: AgentHost): LaunchKind =
  if (host == HostGemini or host == HostMuse) PastePromptOnly
  else if (host == HostHermes or host == HostOpenClaw) CliOrSchemeInstall
  else PromptDeepLink

pure def directoryPolicyForHost(host: AgentHost): DirectoryPolicy =
  if (host == HostClaude or host == HostMuse or host == HostOpenClaw) DirectoryListedAtLaunch
  else if (host == HostChatGPT) DirectoryHeldFor18Plus
  else CustomConnectorOnly

pure def resolvedHostLaunch(host: AgentHost, verifiedOnDevice: bool): LaunchKind =
  if (verifiedOnDevice) defaultHostLaunchKind(host) else CopyPromptFallback

pure def joinSheetActionFor(s: SkillPublisher, host: AgentHost): LaunchKind =
  resolvedHostLaunch(host, s.verifiedHosts.includes(host))

pure def canVerifyHostLink(s: SkillPublisher, host: AgentHost): bool =
  not(s.verifiedHosts.includes(host))

pure def verifyHostLink(s: SkillPublisher, host: AgentHost): SkillStep =
  { state: { ...s, verifiedHosts: s.verifiedHosts.append(host) }, out: List() }
```

### Single-source digest equality, HTTPS origin authority, and host verification invariants hold inductively

```quint
pure def alwaysSingleSourceDigestsMatch(s: SkillPublisher): bool =
  s.published.isPublished implies (
    sourceValid(s.canonical)
      and s.published.rootSkillDigest == s.canonical.sourceDigest
      and s.published.wellKnownSkillDigest == s.canonical.sourceDigest
      and s.published.indexSha256 == s.canonical.sourceDigest
      and s.published.llmsTxtSourceDigest == s.canonical.sourceDigest
      and s.published.howToPlaySourceDigest == s.canonical.sourceDigest
      and s.published.pluginBundleDigest == s.canonical.sourceDigest
      and s.published.indexUrl == canonicalWellKnownSkillUrl
  )

pure def alwaysAdmittedSkillIsVerified(s: SkillPublisher): bool =
  (s.admissionStatus == AdmissionFetching implies (
    s.published.isPublished and isProductionOrigin(s.fetchOrigin) and s.sameOrigin
  ))
    and (s.admissionStatus == AdmissionDownloaded implies (
      s.published.isPublished and isProductionOrigin(s.fetchOrigin) and s.sameOrigin
    ))
    and (s.admissionStatus == AdmissionAdmitted implies (
      s.published.isPublished
        and isProductionOrigin(s.fetchOrigin)
        and s.sameOrigin
        and s.downloadedSha256 != ""
        and s.downloadedSha256 == s.published.indexSha256
        and s.downloadedSha256 == s.published.rootSkillDigest
        and s.downloadedSha256 == s.published.wellKnownSkillDigest
        and packageValid(s.packageCheck)
        and policyClean(s.downloadedPolicy)
    ))

pure def lawInsecureOrCrossOriginAlwaysRefused(s: SkillPublisher, origin: SkillOrigin, sameOrigin: bool): bool =
  (s.published.isPublished and (not(isProductionOrigin(origin)) or not(sameOrigin))) implies (
    fetchSkill(s, origin, sameOrigin).state.admissionStatus == AdmissionRefused
      and fetchSkill(s, origin, sameOrigin).state.lastRefusal == RefusalInvalidOrigin
  )

pure def lawDigestMismatchAlwaysRefused(s: SkillPublisher): bool =
  (s.admissionStatus == AdmissionDownloaded and s.published.isPublished and isProductionOrigin(s.fetchOrigin) and s.sameOrigin and s.downloadedSha256 != s.published.indexSha256) implies (
    verifyAndAdmitSkill(s).state.admissionStatus == AdmissionRefused
  )

pure def lawUnverifiedHostShowsCopyPromptOnly(host: AgentHost): bool =
  resolvedHostLaunch(host, false) == CopyPromptFallback

pure def sometimesAdmittedCanonicalSkill(s: SkillPublisher): bool =
  s.admissionStatus == AdmissionAdmitted and s.verifiedHosts.includes(HostClaude)

pure def sometimesDigestMismatchRefused(s: SkillPublisher): bool =
  s.admissionStatus == AdmissionRefused and s.lastRefusal == RefusalDigestMismatch

pure def sometimesInsecureOriginRefused(s: SkillPublisher): bool =
  s.admissionStatus == AdmissionRefused and s.lastRefusal == RefusalInvalidOrigin
```

### Simulation samples and witness journeys cover canonical admission, SHA-256 mismatch rejection, and origin rejection

```quint
pure val sha256A: str = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
pure val sha256Tampered: str = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"

pure val canonicalSourceA: CanonicalSource = {
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
  sourceDigest: sha256A,
  mcpUrl: canonicalMcpUrl,
  sourcePolicy: cleanPolicy,
}

pure val sourceValues: Set[CanonicalSource] = Set(
  canonicalSourceA,
  { ...canonicalSourceA, sourcePolicy: { ...cleanPolicy, noPurchaseLinksOrUpsell: false } }
)

pure val downloadedSha256Values: Set[str] = Set(sha256A, sha256Tampered)
pure val downloadedPolicyValues: Set[SkillPolicy] = Set(cleanPolicy, { ...cleanPolicy, neverAskPhoneOrCode: false })
pure val pkgCheckValues: Set[PackageCheck] = Set(
  { realDirectory: true, boundedFiles: true, validYamlFrontmatter: true },
  { realDirectory: false, boundedFiles: true, validYamlFrontmatter: true }
)

pure val eval_witness_sometimesAdmittedCanonicalSkill = (
  ("publishSkillBundle", canonicalSourceA),
  ("verifyHostLink", HostClaude),
  ("fetchSkill", OriginWellKnownHttps, true),
  ("completeDownload", sha256A, cleanPolicy, { realDirectory: true, boundedFiles: true, validYamlFrontmatter: true }),
  "verifyAndAdmitSkill"
)

pure val eval_witness_sometimesDigestMismatchRefused = (
  ("publishSkillBundle", canonicalSourceA),
  ("fetchSkill", OriginWellKnownHttps, true),
  ("completeDownload", sha256Tampered, cleanPolicy, { realDirectory: true, boundedFiles: true, validYamlFrontmatter: true }),
  "verifyAndAdmitSkill"
)

pure val eval_witness_sometimesInsecureOriginRefused = (
  ("publishSkillBundle", canonicalSourceA),
  ("fetchSkill", OriginHttpInsecure, true)
)
```
