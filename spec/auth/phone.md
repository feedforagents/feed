# Phone authentication and account lifecycle

Feed uses **first-party phone-only authentication** over `@elizaos/cloud` session/challenge primitives, replacing Steward (D-1) and retiring all legacy accounts (D-8). Sign-in uses a 6-digit SMS autofill code via Twilio Verify (`@feed.fun #123456`) with **no magic links** (D-2). Raw phone numbers and codes are modeled with `SecretPhone` and `SecretCode` (`SPEC.md#secrets`), leaving only a keyed HMAC `phoneHash` and `declassifyPhoneLast2` in public views.

## Story: Verify a phone number safely without magic links or SMS pumping

> As a player signing in with my phone, I want a quick 6-digit SMS code that stops bots, VoIP abuse, and brute-force guessing without ever exposing my raw phone number to agents or public logs.

### Only allowed countries, non-VoIP lines, Turnstile-verified requests, and rate-limited numbers receive a 6-digit autofill code

Launch coverage allows `US`, `CA`, `UK`, `IE`, `AU`, `NZ`, and `EU/EEA` (D-3). Twilio Lookup Line Type Intelligence rejects VoIP and non-fixed-VoIP numbers (D-4, D-32); premium and toll-free prefixes are blocked; Cloudflare Turnstile is required on every send; and per-number rate limits enforce a `30 s` resend gap, `3` sends per hour, and `6` sends per day alongside deployment IP/global SMS pumping ceilings.

```quint
type Millis = int
type SecretPhone = str
type SecretCode = str

type CountryEligibility =
  | CountryUs
  | CountryCa
  | CountryUk
  | CountryIe
  | CountryAu
  | CountryNz
  | CountryEuEea
  | CountryBlocked

type SmsFormat =
  | SmsAutofillCode
  | SmsMagicLinkDisabled

type AccountStatus =
  | AccountUnregistered
  | AccountPendingOnboarding
  | AccountActive
  | AccountDeletedCooldown
  | AccountErased

type ChallengeStatus =
  | ChallengeIdle
  | ChallengeOpen
  | ChallengeLocked
  | ChallengeExpired

type ChallengePurpose =
  | PurposeSignIn
  | PurposeChangePhone

type PhoneEffect =
  | DispatchTwilioSms({ toPhone: SecretPhone, smsCode: SecretCode, smsFormat: SmsFormat })
  | IssueStartingGrant({ grantUserId: str, grantPoints: int })
  | RevokeAllSessions({ sessionUserId: str, toEpoch: int })
  | AuditReviewerSignIn({ reviewerUserId: str, auditedAt: Millis })

type PhoneAuth = {
  status: AccountStatus,
  userId: str,
  username: str,
  isReviewer: bool,
  ageConfirmed: bool,
  termsAccepted: bool,
  phoneVerified: bool,
  phoneHash: str,
  phoneLast2: str,
  phoneReleased: bool,
  pointsBalance: int,
  startingGrantIssued: bool,
  startingGrantCount: int,
  sessionsEpoch: int,
  lastSignInAt: Millis,
  deletedAt: Millis,
  cooldownEndsAt: Millis,
  challengeStatus: ChallengeStatus,
  challengePurpose: ChallengePurpose,
  pendingPhone: SecretPhone,
  pendingPhoneHash: str,
  pendingPhoneLast2: str,
  pendingCode: SecretCode,
  codeSentAt: Millis,
  codeExpiresAt: Millis,
  codeAttempts: int,
  hasSentBefore: bool,
  lastSentAt: Millis,
  hourWindowStart: Millis,
  hourSends: int,
  dayWindowStart: Millis,
  daySends: int,
  reviewerAuditCount: int,
  now: Millis,
}

type PublicAccountView = {
  viewUserId: str,
  viewUsername: str,
  viewStatus: AccountStatus,
  viewPhoneHash: str,
  viewPhoneLast2: str,
  viewAgeConfirmed: bool,
  viewIsReviewer: bool,
  viewStartingGrantIssued: bool,
  viewSessionsEpoch: int,
}

type PhoneStep = {
  state: PhoneAuth,
  out: List[PhoneEffect],
}

pure val resendGapMs: Millis = 30000
pure val codeLifetimeMs: Millis = 600000
pure val recentSignInWindowMs: Millis = 600000
pure val hourMs: Millis = 3600000
pure val dayMs: Millis = 86400000
pure val phoneCooldownMs: Millis = 2592000000
pure val maxCodeAttempts: int = 5
pure val maxSendsPerHour: int = 3
pure val maxSendsPerDay: int = 6
pure val startingGrantPoints: int = 100

pure val initial: PhoneAuth = {
  status: AccountUnregistered,
  userId: "",
  username: "",
  isReviewer: false,
  ageConfirmed: false,
  termsAccepted: false,
  phoneVerified: false,
  phoneHash: "",
  phoneLast2: "",
  phoneReleased: false,
  pointsBalance: 0,
  startingGrantIssued: false,
  startingGrantCount: 0,
  sessionsEpoch: 0,
  lastSignInAt: 0,
  deletedAt: 0,
  cooldownEndsAt: 0,
  challengeStatus: ChallengeIdle,
  challengePurpose: PurposeSignIn,
  pendingPhone: "",
  pendingPhoneHash: "",
  pendingPhoneLast2: "",
  pendingCode: "",
  codeSentAt: 0,
  codeExpiresAt: 0,
  codeAttempts: 0,
  hasSentBefore: false,
  lastSentAt: 0,
  hourWindowStart: 0,
  hourSends: 0,
  dayWindowStart: 0,
  daySends: 0,
  reviewerAuditCount: 0,
  now: 0,
}

pure def countryAllowed(country: CountryEligibility): bool =
  country != CountryBlocked

pure def declassifyPhoneLast2(phone: SecretPhone): str =
  if (phone == "+14155550101") "01"
  else if (phone == "+14155550102") "02"
  else if (phone == "+447700900099") "99"
  else if (phone == "") ""
  else "00"

pure def publicAccountView(s: PhoneAuth): PublicAccountView = {
  viewUserId: s.userId,
  viewUsername: s.username,
  viewStatus: s.status,
  viewPhoneHash: s.phoneHash,
  viewPhoneLast2: s.phoneLast2,
  viewAgeConfirmed: s.ageConfirmed,
  viewIsReviewer: s.isReviewer,
  viewStartingGrantIssued: s.startingGrantIssued,
  viewSessionsEpoch: s.sessionsEpoch,
}

pure def inActiveHourWindow(s: PhoneAuth): bool =
  s.hasSentBefore and s.now < s.hourWindowStart + hourMs

pure def inActiveDayWindow(s: PhoneAuth): bool =
  s.hasSentBefore and s.now < s.dayWindowStart + dayMs

pure def currentHourSends(s: PhoneAuth): int =
  if (inActiveHourWindow(s)) s.hourSends else 0

pure def currentDaySends(s: PhoneAuth): int =
  if (inActiveDayWindow(s)) s.daySends else 0

pure def resendGapOk(s: PhoneAuth): bool =
  not(s.hasSentBefore) or s.now >= s.lastSentAt + resendGapMs

pure def withinSendRateLimits(s: PhoneAuth): bool =
  resendGapOk(s) and currentHourSends(s) < maxSendsPerHour and currentDaySends(s) < maxSendsPerDay

pure def sendEligible(
  country: CountryEligibility,
  isVoip: bool,
  isPremiumOrTollFree: bool,
  turnstilePassed: bool,
  ipAndGlobalAllowed: bool
): bool =
  countryAllowed(country)
    and not(isVoip)
    and not(isPremiumOrTollFree)
    and turnstilePassed
    and ipAndGlobalAllowed

pure def openChallenge(
  purpose: ChallengePurpose,
  s: PhoneAuth,
  phone: SecretPhone,
  phoneHash: str,
  issuedCode: SecretCode
): PhoneStep = {
  val nextHourStart = if (inActiveHourWindow(s)) s.hourWindowStart else s.now
  val nextDayStart = if (inActiveDayWindow(s)) s.dayWindowStart else s.now
  {
    state: {
      ...s,
      challengeStatus: ChallengeOpen,
      challengePurpose: purpose,
      pendingPhone: phone,
      pendingPhoneHash: phoneHash,
      pendingPhoneLast2: declassifyPhoneLast2(phone),
      pendingCode: issuedCode,
      codeSentAt: s.now,
      codeExpiresAt: s.now + codeLifetimeMs,
      codeAttempts: 0,
      hasSentBefore: true,
      lastSentAt: s.now,
      hourWindowStart: nextHourStart,
      hourSends: currentHourSends(s) + 1,
      dayWindowStart: nextDayStart,
      daySends: currentDaySends(s) + 1,
    },
    out: List(DispatchTwilioSms({ toPhone: phone, smsCode: issuedCode, smsFormat: SmsAutofillCode })),
  }
}

pure def canRequestSignInCode(
  s: PhoneAuth,
  phoneHash: str,
  country: CountryEligibility,
  isVoip: bool,
  isPremiumOrTollFree: bool,
  turnstilePassed: bool,
  ipAndGlobalAllowed: bool
): bool =
  phoneHash != ""
    and not(s.isReviewer)
    and (s.status == AccountUnregistered or (s.status == AccountActive and phoneHash == s.phoneHash))
    and sendEligible(country, isVoip, isPremiumOrTollFree, turnstilePassed, ipAndGlobalAllowed)
    and withinSendRateLimits(s)

pure def requestSignInCode(
  s: PhoneAuth,
  phone: SecretPhone,
  phoneHash: str,
  issuedCode: SecretCode,
  country: CountryEligibility,
  isVoip: bool,
  isPremiumOrTollFree: bool,
  turnstilePassed: bool,
  ipAndGlobalAllowed: bool
): PhoneStep =
  openChallenge(PurposeSignIn, s, phone, phoneHash, issuedCode)
```

### Codes expire in 10 minutes, lock after 5 wrong attempts, and verify without leaking secrets

Verification checks `codeMatches` (evaluated by Twilio Verify on the submitted 6-digit `SecretCode`) while the challenge is open and unexpired. Five failed tries lock the challenge and purge any pending secret phone or code from state.

```quint
pure def clearChallenge(nextChallengeStatus: ChallengeStatus, s: PhoneAuth): PhoneAuth = {
  ...s,
  challengeStatus: nextChallengeStatus,
  pendingPhone: "",
  pendingPhoneHash: "",
  pendingPhoneLast2: "",
  pendingCode: "",
  codeAttempts: if (nextChallengeStatus == ChallengeLocked) maxCodeAttempts else 0,
}

pure def applyCodeFailure(nextAttempts: int, s: PhoneAuth): PhoneStep =
  if (nextAttempts >= maxCodeAttempts)
    { state: clearChallenge(ChallengeLocked, s), out: List() }
  else
    { state: { ...s, codeAttempts: nextAttempts }, out: List() }

pure def applyCodeSuccess(assignedUserId: str, s: PhoneAuth): PhoneStep = {
  val cleared = clearChallenge(ChallengeIdle, s)
  val nextEpoch = s.sessionsEpoch + 1
  if (s.status == AccountUnregistered)
    {
      state: {
        ...cleared,
        status: AccountPendingOnboarding,
        userId: assignedUserId,
        phoneVerified: true,
        phoneHash: s.pendingPhoneHash,
        phoneLast2: s.pendingPhoneLast2,
        phoneReleased: false,
        sessionsEpoch: 1,
        lastSignInAt: s.now,
      },
      out: List(),
    }
  else if (s.challengePurpose == PurposeChangePhone)
    {
      state: {
        ...cleared,
        phoneVerified: true,
        phoneHash: s.pendingPhoneHash,
        phoneLast2: s.pendingPhoneLast2,
        sessionsEpoch: nextEpoch,
        lastSignInAt: s.now,
      },
      out: List(RevokeAllSessions({ sessionUserId: s.userId, toEpoch: nextEpoch })),
    }
  else
    {
      state: {
        ...cleared,
        lastSignInAt: s.now,
      },
      out: List(),
    }
}

pure def canVerifyCode(s: PhoneAuth, codeMatches: bool, assignedUserId: str): bool =
  s.challengeStatus == ChallengeOpen
    and s.now < s.codeExpiresAt
    and s.codeAttempts < maxCodeAttempts
    and ((s.status == AccountUnregistered and codeMatches) implies assignedUserId != "")

pure def verifyCode(s: PhoneAuth, codeMatches: bool, assignedUserId: str): PhoneStep =
  if (not(codeMatches)) applyCodeFailure(s.codeAttempts + 1, s)
  else applyCodeSuccess(assignedUserId, s)

pure def canExpireCode(s: PhoneAuth): bool =
  s.challengeStatus == ChallengeOpen and s.now >= s.codeExpiresAt

pure def expireCode(s: PhoneAuth): PhoneStep =
  { state: clearChallenge(ChallengeExpired, s), out: List() }
```

## Story: Onboard once, change phone, sign out everywhere, or delete after cooldown

> As a verified user, I want to pick a username, confirm 18+ and Terms to receive my one-time 100 pts grant, manage my phone number and active sessions, and delete my account with a 30-day phone cooldown.

### Onboarding requires username, 18+ self-attestation, and Terms, and issues 100 pts once per verified phone

New phone sign-ups remain in `AccountPendingOnboarding` until `completeOnboarding` records a non-empty `username`, `ageConfirmed == true` (D-19), and `termsAccepted == true`. Completing onboarding activates the account and emits the one-time `100 pts` starting grant (D-11).

```quint
pure def canCompleteOnboarding(s: PhoneAuth, username: str, ageConfirmed: bool, termsAccepted: bool): bool =
  s.status == AccountPendingOnboarding
    and s.phoneVerified
    and not(s.isReviewer)
    and not(s.startingGrantIssued)
    and username != ""
    and ageConfirmed
    and termsAccepted

pure def completeOnboarding(s: PhoneAuth, username: str, ageConfirmed: bool, termsAccepted: bool): PhoneStep = {
  val nextBalance = s.pointsBalance + startingGrantPoints
  {
    state: {
      ...s,
      status: AccountActive,
      username: username,
      ageConfirmed: true,
      termsAccepted: true,
      pointsBalance: nextBalance,
      startingGrantIssued: true,
      startingGrantCount: s.startingGrantCount + 1,
    },
    out: List(IssueStartingGrant({ grantUserId: s.userId, grantPoints: startingGrantPoints })),
  }
}
```

### Changing phone requires verifying the old phone or support recovery and an unused new number

```quint
pure def canRequestPhoneChangeCode(
  s: PhoneAuth,
  newPhoneHash: str,
  country: CountryEligibility,
  isVoip: bool,
  isPremiumOrTollFree: bool,
  turnstilePassed: bool,
  ipAndGlobalAllowed: bool,
  oldPhoneVerifiedOrRecovery: bool,
  newPhoneUnused: bool
): bool =
  s.status == AccountActive
    and not(s.isReviewer)
    and newPhoneHash != ""
    and newPhoneHash != s.phoneHash
    and oldPhoneVerifiedOrRecovery
    and newPhoneUnused
    and sendEligible(country, isVoip, isPremiumOrTollFree, turnstilePassed, ipAndGlobalAllowed)
    and withinSendRateLimits(s)

pure def requestPhoneChangeCode(
  s: PhoneAuth,
  newPhone: SecretPhone,
  newPhoneHash: str,
  issuedCode: SecretCode,
  country: CountryEligibility,
  isVoip: bool,
  isPremiumOrTollFree: bool,
  turnstilePassed: bool,
  ipAndGlobalAllowed: bool,
  oldPhoneVerifiedOrRecovery: bool,
  newPhoneUnused: bool
): PhoneStep =
  openChallenge(PurposeChangePhone, s, newPhone, newPhoneHash, issuedCode)
```

### Sign out everywhere bumps `sessionsEpoch`, and self-serve deletion holds the phone hash for 30 days

Self-serve account deletion requires a recent sign-in within the last `10` minutes, revokes all sessions immediately, and retains `phoneHash` during the 30-day cooldown (D-20). Once the 30-day cooldown elapses, `releasePhoneHash` erases `phoneHash` and marks the phone free.

```quint
pure def canSignOutEverywhere(s: PhoneAuth): bool =
  s.status == AccountActive

pure def signOutEverywhere(s: PhoneAuth): PhoneStep = {
  val nextEpoch = s.sessionsEpoch + 1
  {
    state: { ...s, sessionsEpoch: nextEpoch },
    out: List(RevokeAllSessions({ sessionUserId: s.userId, toEpoch: nextEpoch })),
  }
}

pure def canDeleteAccount(s: PhoneAuth): bool =
  s.status == AccountActive
    and not(s.isReviewer)
    and s.phoneVerified
    and s.now - s.lastSignInAt <= recentSignInWindowMs

pure def deleteAccount(s: PhoneAuth): PhoneStep = {
  val cleared = clearChallenge(ChallengeIdle, s)
  val nextEpoch = s.sessionsEpoch + 1
  {
    state: {
      ...cleared,
      status: AccountDeletedCooldown,
      username: "",
      deletedAt: s.now,
      cooldownEndsAt: s.now + phoneCooldownMs,
      sessionsEpoch: nextEpoch,
    },
    out: List(RevokeAllSessions({ sessionUserId: s.userId, toEpoch: nextEpoch })),
  }
}

pure def canReleasePhoneHash(s: PhoneAuth): bool =
  s.status == AccountDeletedCooldown and s.now >= s.cooldownEndsAt

pure def releasePhoneHash(s: PhoneAuth): PhoneStep =
  {
    state: {
      ...s,
      status: AccountErased,
      phoneHash: "",
      phoneLast2: "",
      phoneVerified: false,
      phoneReleased: true,
    },
    out: List(),
  }

pure def canElapse(s: PhoneAuth, elapsed: Millis): bool =
  elapsed > 0

pure def elapse(s: PhoneAuth, elapsed: Millis): PhoneStep =
  { state: { ...s, now: s.now + elapsed }, out: List() }
```

## Story: Admit directory reviewer password sign-in only for `isReviewer` accounts

> As an operator submitting Feed to agent directories, I want password sign-in strictly restricted to operator-seeded `isReviewer` demo accounts with every login audited, so that no player account can ever authenticate with a password.

### Username and password sign-in is admitted solely when `isReviewer` is true (D-29)

```quint
pure def admitPasswordSignIn(s: PhoneAuth, username: str, passwordMatches: bool): bool =
  s.status == AccountActive
    and s.isReviewer
    and username != ""
    and username == s.username
    and passwordMatches

pure def canProvisionReviewer(s: PhoneAuth, assignedUserId: str, username: str): bool =
  s.status == AccountUnregistered and assignedUserId != "" and username != ""

pure def provisionReviewer(s: PhoneAuth, assignedUserId: str, username: str): PhoneStep =
  {
    state: {
      ...clearChallenge(ChallengeIdle, s),
      status: AccountActive,
      userId: assignedUserId,
      username: username,
      isReviewer: true,
      ageConfirmed: true,
      termsAccepted: true,
      phoneVerified: false,
      sessionsEpoch: 1,
      lastSignInAt: s.now,
    },
    out: List(),
  }

pure def canSignInReviewerPassword(s: PhoneAuth, username: str, passwordMatches: bool): bool =
  admitPasswordSignIn(s, username, passwordMatches)

pure def signInReviewerPassword(s: PhoneAuth, username: str, passwordMatches: bool): PhoneStep =
  {
    state: {
      ...s,
      lastSignInAt: s.now,
      reviewerAuditCount: s.reviewerAuditCount + 1,
    },
    out: List(AuditReviewerSignIn({ reviewerUserId: s.userId, auditedAt: s.now })),
  }
```

## Story: Enforce inductive phone-auth invariants and verify reachable milestones

### Active accounts, one-time grants, cooldown release, and secret clearing hold inductively

```quint
pure def alwaysClockAndChallengeValid(s: PhoneAuth): bool =
  s.now >= 0
    and s.sessionsEpoch >= 0
    and s.pointsBalance >= 0
    and s.reviewerAuditCount >= 0
    and 0 <= s.lastSignInAt and s.lastSignInAt <= s.now
    and 0 <= s.deletedAt and s.deletedAt <= s.now
    and 0 <= s.codeAttempts and s.codeAttempts <= maxCodeAttempts
    and ((s.challengeStatus == ChallengeLocked) iff (s.codeAttempts == maxCodeAttempts))
    and 0 <= s.hourSends and s.hourSends <= maxSendsPerHour
    and 0 <= s.daySends and s.daySends <= maxSendsPerDay
    and (s.hasSentBefore implies (
      0 <= s.hourWindowStart and s.hourWindowStart <= s.now
        and 0 <= s.dayWindowStart and s.dayWindowStart <= s.now
        and 0 <= s.lastSentAt and s.lastSentAt <= s.now
    ))
    and (s.challengeStatus == ChallengeOpen implies (
      s.hasSentBefore
        and s.codeSentAt <= s.now
        and s.codeExpiresAt == s.codeSentAt + codeLifetimeMs
        and s.pendingPhoneHash != ""
        and s.codeAttempts < maxCodeAttempts
    ))
    and (s.challengeStatus != ChallengeOpen implies (
      s.pendingPhone == "" and s.pendingCode == "" and s.pendingPhoneHash == "" and s.pendingPhoneLast2 == ""
    ))
    and ((s.challengeStatus == ChallengeOpen and s.challengePurpose == PurposeChangePhone) implies (
      s.status == AccountActive and not(s.isReviewer) and s.pendingPhoneHash != s.phoneHash
    ))
    and ((s.challengeStatus == ChallengeOpen and s.challengePurpose == PurposeSignIn) implies (
      s.status == AccountUnregistered or (s.status == AccountActive and not(s.isReviewer) and s.pendingPhoneHash == s.phoneHash)
    ))

pure def alwaysActiveNonReviewerVerifiedAndAdult(s: PhoneAuth): bool =
  ((s.status == AccountActive and not(s.isReviewer)) implies (
    s.phoneVerified
      and s.phoneHash != ""
      and s.ageConfirmed
      and s.termsAccepted
      and s.username != ""
      and s.userId != ""
      and s.sessionsEpoch >= 1
  ))
    and ((s.status == AccountActive and s.isReviewer) implies (
      s.ageConfirmed
        and s.termsAccepted
        and s.username != ""
        and s.userId != ""
        and s.sessionsEpoch >= 1
        and not(s.startingGrantIssued)
        and s.startingGrantCount == 0
    ))
    and (s.status == AccountPendingOnboarding implies (
      not(s.isReviewer)
        and s.challengeStatus == ChallengeIdle
        and s.phoneVerified
        and s.phoneHash != ""
        and s.userId != ""
        and not(s.startingGrantIssued)
        and s.startingGrantCount == 0
    ))
    and (s.status == AccountUnregistered implies (
      not(s.isReviewer)
        and not(s.phoneVerified)
        and s.phoneHash == ""
        and s.userId == ""
        and s.username == ""
        and not(s.startingGrantIssued)
        and s.startingGrantCount == 0
        and not(s.phoneReleased)
    ))
    and (s.isReviewer implies (
      s.challengeStatus == ChallengeIdle
        and not(s.phoneVerified)
        and s.phoneHash == ""
        and not(s.phoneReleased)
    ))

pure def alwaysStartingGrantAtMostOnce(s: PhoneAuth): bool =
  0 <= s.startingGrantCount
    and s.startingGrantCount <= 1
    and (s.startingGrantIssued iff (s.startingGrantCount == 1))
    and (s.startingGrantIssued implies not(s.isReviewer))

pure def alwaysPhoneHashReleasedOnlyAfterCooldown(s: PhoneAuth): bool =
  (s.status == AccountDeletedCooldown implies (
    not(s.isReviewer)
      and s.challengeStatus == ChallengeIdle
      and s.phoneVerified
      and s.phoneHash != ""
      and not(s.phoneReleased)
      and s.cooldownEndsAt == s.deletedAt + phoneCooldownMs
  ))
    and (s.status == AccountErased implies (
      not(s.isReviewer)
        and s.challengeStatus == ChallengeIdle
        and s.phoneReleased
        and s.phoneHash == ""
        and s.phoneLast2 == ""
        and not(s.phoneVerified)
        and s.now >= s.cooldownEndsAt
        and s.cooldownEndsAt == s.deletedAt + phoneCooldownMs
    ))
    and ((s.status != AccountErased) implies not(s.phoneReleased))

pure def stepGrantAndSessionMonotonicity(before: PhoneAuth, via: str, after: PhoneAuth, out: List[PhoneEffect]): bool =
  after.startingGrantCount >= before.startingGrantCount
    and after.sessionsEpoch >= before.sessionsEpoch
    and (via == "completeOnboarding" implies (
      before.status == AccountPendingOnboarding
        and after.status == AccountActive
        and after.pointsBalance == before.pointsBalance + startingGrantPoints
        and out == List(IssueStartingGrant({ grantUserId: after.userId, grantPoints: startingGrantPoints }))
    ))
    and (via == "signInReviewerPassword" implies (
      before.isReviewer and after.reviewerAuditCount == before.reviewerAuditCount + 1
    ))
    and (via == "deleteAccount" implies (
      before.status == AccountActive
        and not(before.isReviewer)
        and before.now - before.lastSignInAt <= recentSignInWindowMs
        and after.status == AccountDeletedCooldown
    ))

pure def lawNonReviewerPasswordAlwaysRefused(s: PhoneAuth, username: str, passwordMatches: bool): bool =
  not(s.isReviewer) implies not(admitPasswordSignIn(s, username, passwordMatches))

pure def lawBlockedSendCriteriaRefused(
  s: PhoneAuth,
  phoneHash: str,
  country: CountryEligibility,
  isVoip: bool,
  isPremiumOrTollFree: bool,
  turnstilePassed: bool,
  ipAndGlobalAllowed: bool
): bool =
  (not(countryAllowed(country)) or isVoip or isPremiumOrTollFree or not(turnstilePassed) or not(ipAndGlobalAllowed)) implies
    not(canRequestSignInCode(s, phoneHash, country, isVoip, isPremiumOrTollFree, turnstilePassed, ipAndGlobalAllowed))

pure def lawCooldownBlocksEarlyRelease(s: PhoneAuth): bool =
  (alwaysPhoneHashReleasedOnlyAfterCooldown(s) and s.now < s.cooldownEndsAt) implies not(canReleasePhoneHash(s))

pure def sometimesSignedUpWithStartingGrant(s: PhoneAuth): bool =
  s.status == AccountActive and not(s.isReviewer) and s.startingGrantIssued and s.pointsBalance == startingGrantPoints

pure def sometimesPhoneChanged(s: PhoneAuth): bool =
  s.status == AccountActive and s.phoneHash == "ph_02" and s.startingGrantCount == 1

pure def sometimesLockedAfterFiveWrongAttempts(s: PhoneAuth): bool =
  s.challengeStatus == ChallengeLocked and s.codeAttempts == maxCodeAttempts

pure def sometimesDeletedAndPhoneReleased(s: PhoneAuth): bool =
  s.status == AccountErased and s.phoneReleased and s.phoneHash == ""

pure def sometimesReviewerSignedIn(s: PhoneAuth): bool =
  s.status == AccountActive and s.isReviewer and s.reviewerAuditCount >= 1

pure def sometimesSignedOutEverywhere(s: PhoneAuth): bool =
  s.status == AccountActive and s.sessionsEpoch >= 2
```

### Discovered by the proof: Unregistered accounts have session epoch zero and onboarding accounts have at least one

An unregistered account has not yet established a session (`sessionsEpoch == 0`), and a verified account awaiting onboarding already carries `sessionsEpoch >= 1` into activation.

```quint
pure def alwaysUnregisteredAndOnboardingSessionEpoch(s: PhoneAuth): bool =
  (s.status == AccountUnregistered implies s.sessionsEpoch == 0)
    and (s.status == AccountPendingOnboarding implies s.sessionsEpoch >= 1)
```

### Simulation samples and witness journeys cover onboarding, lockouts, phone change, deletion cooldown, and reviewer sign-in

```quint
pure val phoneValues: Set[SecretPhone] = Set("+14155550101", "+14155550102", "+447700900099")
pure val newPhoneValues: Set[SecretPhone] = Set("+14155550102", "+447700900099")
pure val phoneHashValues: Set[str] = Set("ph_01", "ph_02", "ph_99")
pure val newPhoneHashValues: Set[str] = Set("ph_02", "ph_99")
pure val issuedCodeValues: Set[SecretCode] = Set("123456", "654321")
pure val assignedUserIdValues: Set[str] = Set("user-1", "user-2")
pure val usernameValues: Set[str] = Set("alice", "reviewer_demo")
pure val elapsedValues: Set[Millis] = Set(0, 30000, 600000, 3600000, 86400000, 2592000000)

pure val eval_witness_sometimesSignedUpWithStartingGrant = (
  ("requestSignInCode", "+14155550101", "ph_01", "123456", CountryUs, false, false, true, true),
  ("verifyCode", true, "user-1"),
  ("completeOnboarding", "alice", true, true)
)

pure val eval_witness_sometimesPhoneChanged = (
  ("requestSignInCode", "+14155550101", "ph_01", "123456", CountryUs, false, false, true, true),
  ("verifyCode", true, "user-1"),
  ("completeOnboarding", "alice", true, true),
  ("elapse", 30000),
  ("requestPhoneChangeCode", "+14155550102", "ph_02", "654321", CountryCa, false, false, true, true, true, true),
  ("verifyCode", true, "user-1")
)

pure val eval_witness_sometimesLockedAfterFiveWrongAttempts = (
  ("requestSignInCode", "+14155550101", "ph_01", "123456", CountryUs, false, false, true, true),
  ("verifyCode", false, "user-1"),
  ("verifyCode", false, "user-1"),
  ("verifyCode", false, "user-1"),
  ("verifyCode", false, "user-1"),
  ("verifyCode", false, "user-1")
)

pure val eval_witness_sometimesDeletedAndPhoneReleased = (
  ("requestSignInCode", "+14155550101", "ph_01", "123456", CountryUs, false, false, true, true),
  ("verifyCode", true, "user-1"),
  ("completeOnboarding", "alice", true, true),
  "deleteAccount",
  ("elapse", 2592000000),
  "releasePhoneHash"
)

pure val eval_witness_sometimesReviewerSignedIn = (
  ("provisionReviewer", "rev-1", "reviewer_demo"),
  ("signInReviewerPassword", "reviewer_demo", true)
)

pure val eval_witness_sometimesSignedOutEverywhere = (
  ("requestSignInCode", "+14155550101", "ph_01", "123456", CountryUs, false, false, true, true),
  ("verifyCode", true, "user-1"),
  ("completeOnboarding", "alice", true, true),
  "signOutEverywhere"
)
```
