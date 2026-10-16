import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createAuthService } from './service';
import { AgentRole } from '../agent/types';
import { EmailService, buildVerificationEmail, createEmailService, isDevEmailFallbackAllowed } from './email';
import { VerificationStore, createVerificationStore } from './verification';
import { logger } from '../lib/logger';
import { ROLE_ID_TO_LEGACY_AGENT_ROLE } from './permissionService';
import { buildLoadedAuthTokenPayload, loadUserWithRoles, serializeAuthUser } from './tokenHelpers';
import { createLoginRateLimiter } from './loginRateLimiter';
import { pickRequestToken } from './middleware';

type AuthRouterOptions = {
  prisma: PrismaClient;
  email?: EmailService;
  verification?: VerificationStore;
  requireEmailVerification?: boolean;
  /**
   * 登录防爆破限流配置（默认：同一 IP+账号 15 分钟内最多 5 次失败）。
   * 传 false 显式关闭（测试场景）；亦可用环境变量 BAMBOOK_LOGIN_RATE_LIMIT_DISABLED=1 关闭，
   * 或用 BAMBOOK_LOGIN_RATE_LIMIT_WINDOW_MS / BAMBOOK_LOGIN_RATE_LIMIT_MAX_FAILURES 调整阈值。
   */
  loginRateLimit?: { windowMs?: number; maxFailures?: number } | false;
};

const COOKIE_NAME = 'bambook_token';
const COOKIE_MAX_AGE = 7 * 24 * 3600 * 1000;
const AVATAR_PRESET_RE = /^dicebear:v1:(blobs|disco|glass|glyphs|squircles|slice|waves|weave|critters|cameo|line-face|thumbs|landscape|croodles-neutral|dylan|fun-emoji|gaze|pixelbot|rings|stripes|planets):([A-Za-z0-9_-]{1,80}):(animated|still)$/;
const AVATAR_DATA_URL_RE = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/;

function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeLoginIdentifier(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function createAuthRouter(options: AuthRouterOptions) {
  const router = Router();
  const auth = createAuthService();
  const email = options.email || createEmailService();
  const verification = options.verification || createVerificationStore();

  const envWindowMs = Number(process.env.BAMBOOK_LOGIN_RATE_LIMIT_WINDOW_MS);
  const envMaxFailures = Number(process.env.BAMBOOK_LOGIN_RATE_LIMIT_MAX_FAILURES);
  const loginRateLimiter =
    options.loginRateLimit === false || process.env.BAMBOOK_LOGIN_RATE_LIMIT_DISABLED === '1'
      ? null
      : createLoginRateLimiter({
          windowMs: (options.loginRateLimit && options.loginRateLimit.windowMs) || envWindowMs || undefined,
          maxFailures: (options.loginRateLimit && options.loginRateLimit.maxFailures) || envMaxFailures || undefined,
        });

  router.post('/login', async (req: Request, res: Response) => {
    const { email, identifier, password } = req.body || {};
    const loginIdentifier = normalizeLoginIdentifier(identifier || email);
    if (!loginIdentifier || !password) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', message: 'Name/email and password are required.' });
    }

    // 防爆破：同一 IP 对同一账号的失败尝试计入滑动窗口，超限直接 429（不查库）
    const rateLimitKey = `${req.ip || 'unknown'}|${loginIdentifier.toLowerCase()}`;
    if (loginRateLimiter) {
      const verdict = loginRateLimiter.check(rateLimitKey);
      if (verdict.blocked) {
        return res.status(429).json({
          ok: false,
          error: 'RATE_LIMITED',
          message: '登录失败次数过多，请稍后重试。',
          retryAfterMs: verdict.retryAfterMs,
        });
      }
    }

    const normalizedEmail = normalizeEmail(loginIdentifier);
    const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail);
    const user = await options.prisma.userAccount.findFirst({
      where: {
        deletedAt: null,
        OR: looksLikeEmail
          ? [{ email: { equals: normalizedEmail, mode: 'insensitive' } }]
          : [
              { displayName: { equals: loginIdentifier, mode: 'insensitive' } },
              { email: { equals: normalizedEmail, mode: 'insensitive' } },
            ],
      },
      include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } }, primaryDepartment: true },
    });

    if (!user || !user.passwordHash) {
      loginRateLimiter?.recordFailure(rateLimitKey);
      return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS', message: '姓名/邮箱或密码不正确。' });
    }

    if (user.status === 'pending') {
      return res.status(403).json({ ok: false, error: 'PENDING_APPROVAL', message: '账号待管理员审批，请联系管理员。' });
    }
    if (user.status === 'rejected') {
      return res.status(403).json({ ok: false, error: 'REJECTED', message: '账号申请已被拒绝。' });
    }
    if (user.status === 'disabled') {
      return res.status(403).json({ ok: false, error: 'DISABLED', message: '账号已被停用。' });
    }
    if (user.status !== 'active') {
      return res.status(403).json({ ok: false, error: 'INACTIVE', message: '账号当前不可用。' });
    }

    const valid = await auth.verifyPassword(password, user.passwordHash);
    if (!valid) {
      loginRateLimiter?.recordFailure(rateLimitKey);
      return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS', message: '姓名/邮箱或密码不正确。' });
    }

    // 登录成功：清除该 IP+账号的失败计数
    loginRateLimiter?.reset(rateLimitKey);

    let tokenPayload;
    try {
      tokenPayload = await buildLoadedAuthTokenPayload(options.prisma, user);
    } catch (error) {
      logger.error('[auth] current authorization load failed', { userId: user.id, error: (error as Error).message });
      return res.status(500).json({ ok: false, error: 'AUTHORIZATION_LOAD_FAILED', message: '账号权限暂时无法加载，请稍后重试。' });
    }
    const { roles, permissions, departmentIds, roleIds: newRoleIds } = tokenPayload;

    const token = auth.signToken(tokenPayload);

    await options.prisma.userAccount.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), lastLoginIp: req.ip || null },
    });

    await options.prisma.auditLog.create({
      data: { id: `alog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, actorId: user.id, action: 'login', ip: req.ip },
    }).catch(() => undefined);

    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: COOKIE_MAX_AGE,
      path: '/',
    });

    return res.json({
      ok: true,
      user: serializeAuthUser(user, roles, permissions, departmentIds, { newRoleIds, authorizationLoaded: tokenPayload.authorizationLoaded }),
      token,
    });
  });

  router.post('/send-code', async (req: Request, res: Response) => {
    try {
      const { email: targetEmail, purpose } = req.body || {};
      if (!targetEmail || typeof targetEmail !== 'string') {
        return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', message: '请提供邮箱。' });
      }
      const normalizedEmail = normalizeEmail(targetEmail);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        return res.status(400).json({ ok: false, error: 'INVALID_EMAIL', message: '邮箱格式不正确。' });
      }
      const finalPurpose = purpose === 'reset_password' ? 'reset_password' : 'register';

      if (finalPurpose === 'register') {
        const existing = await options.prisma.userAccount.findFirst({
          where: { email: { equals: normalizedEmail, mode: 'insensitive' }, deletedAt: null },
        });
        if (existing) {
          return res.status(409).json({ ok: false, error: 'DUPLICATE', message: '该邮箱已注册或正在审批中。' });
        }
      }

      const issued = await verification.issueCode(normalizedEmail, finalPurpose);
      if (issued.ok === false) {
        return res.status(429).json({ ok: false, error: issued.error, message: issued.message, retryAfterMs: issued.retryAfterMs });
      }

      const message = buildVerificationEmail(issued.code, finalPurpose);
      message.to = normalizedEmail;

      // 凭证类邮件（注册验证码 / 重置密码）不允许静默降级：通道没配好时必须显式失败，
      // 不能回「已发送」却永远送不到。本地联调可显式设 AUTH_ALLOW_DEV_EMAIL_FALLBACK=1 放行。
      const devFallback = isDevEmailFallbackAllowed();
      if (!email.isReal && !devFallback) {
        logger.error('[send-code] 邮件通道未配置，验证码无法送达', {
          to: normalizedEmail,
          transport: email.describe(),
        });
        return res.status(503).json({
          ok: false,
          error: 'EMAIL_NOT_CONFIGURED',
          message: '邮件发送通道未配置，验证码无法送达。请联系管理员配置邮件服务后再试。',
          transport: email.describe(),
        });
      }

      try {
        await email.send(message);
      } catch (err) {
        logger.error('[send-code] email send failed', { error: err instanceof Error ? err.message : String(err) });
        if (!devFallback) {
          const detail = err instanceof Error ? err.message : String(err);
          return res.status(502).json({ ok: false, error: 'EMAIL_FAILED', message: `邮件发送失败：${detail}` });
        }
        logger.warn('[send-code] dev fallback 生效：发送失败仍放行', { to: normalizedEmail });
      }

      return res.json({
        ok: true,
        message: `验证码已发送至 ${normalizedEmail}，10 分钟内有效。`,
        expiresAt: issued.expiresAt.toISOString(),
        cooldownMs: issued.cooldownMs,
        transport: email.describe(),
        // 仅显式开启开发降级时回显，便于本地跑通注册流程；真实通道下绝不回显。
        ...(devFallback ? { devCode: issued.code } : {}),
      });
    } catch (err) {
      logger.error('[send-code] unexpected failure', { error: err instanceof Error ? err.message : String(err) });
      const detail = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ ok: false, error: 'SEND_CODE_FAILED', message: `验证码发送服务异常：${detail}` });
    }
  });

  router.post('/register', async (req: Request, res: Response) => {
    const { email, password, displayName, requestedDepartment, code } = req.body || {};
    if (!email || !password || !displayName) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', message: '邮箱、密码与姓名为必填项。' });
    }
    if (typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ ok: false, error: 'WEAK_PASSWORD', message: '密码至少 6 位。' });
    }
    const normalizedEmail = normalizeEmail(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ ok: false, error: 'INVALID_EMAIL', message: '邮箱格式不正确。' });
    }

    if (options.requireEmailVerification !== false) {
      if (!code || typeof code !== 'string') {
        return res.status(400).json({ ok: false, error: 'MISSING_CODE', message: '请输入邮箱验证码。' });
      }
      const verifyResult = await verification.verifyCode(normalizedEmail, code, 'register');
      if (verifyResult.ok === false) {
        return res.status(400).json({ ok: false, error: verifyResult.error, message: verifyResult.message });
      }
    }

    const existing = await options.prisma.userAccount.findFirst({
      where: { email: { equals: normalizedEmail, mode: 'insensitive' }, deletedAt: null },
    });
    if (existing) {
      return res.status(409).json({ ok: false, error: 'DUPLICATE', message: '该邮箱已注册或正在审批中。' });
    }

    const passwordHash = await auth.hashPassword(password);
    const id = `usr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const user = await options.prisma.userAccount.create({
      data: {
        id,
        displayName,
        email: normalizedEmail,
        passwordHash,
        status: 'pending',
        metadata: {
          requestedDepartment: typeof requestedDepartment === 'string' ? requestedDepartment : null,
          emailVerified: options.requireEmailVerification !== false,
          registeredAt: new Date().toISOString(),
          registeredIp: req.ip || null,
        },
      },
    });

    await options.prisma.auditLog.create({
      data: {
        id: `alog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        actorId: user.id,
        action: 'register',
        targetType: 'UserAccount',
        targetId: user.id,
        detail: { requestedDepartment: requestedDepartment || null },
        ip: req.ip,
      },
    }).catch(() => undefined);

    return res.json({
      ok: true,
      message: '注册成功，账号已提交审批，管理员通过后即可登录。',
      user: { id: user.id, email: user.email, displayName: user.displayName, status: user.status },
    });
  });

  router.get('/me', async (req: Request, res: Response) => {
    // 取凭证走全仓唯一那份规则：显式 Bearer 优先。此处曾写作 cookie 优先（与业务路由相反），
    // 于是同一会话里"屏面显示的身份"（这里）和"数据判决的身份"（middleware）可以判给两个人。
    const token = pickRequestToken(req);
    if (!token) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Not logged in.' });
    }
    try {
      const payload = auth.verifyToken(token);
      const user = await options.prisma.userAccount.findUnique({
        where: { id: payload.userId },
        include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } }, primaryDepartment: true },
      });
      if (!user || user.status !== 'active' || user.deletedAt != null) {
        res.clearCookie(COOKIE_NAME, { path: '/' });
        return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Account disabled.' });
      }
      const tokenPayload = await buildLoadedAuthTokenPayload(options.prisma, user);
      const { roles, permissions, departmentIds, roleIds: newRoleIds } = tokenPayload;
      return res.json({
        ok: true,
        user: serializeAuthUser(user, roles, permissions, departmentIds, { newRoleIds, authorizationLoaded: tokenPayload.authorizationLoaded, permissionCeiling: payload.permissionCeiling }),
      });
    } catch {
      res.clearCookie(COOKIE_NAME, { path: '/' });
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Token expired or invalid.' });
    }
  });

  router.post('/logout', (_req: Request, res: Response) => {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    return res.json({ ok: true });
  });

  router.patch('/me', async (req: Request, res: Response) => {
    // 取凭证走全仓唯一那份规则：显式 Bearer 优先。此处曾写作 cookie 优先（与业务路由相反），
    // 于是同一会话里"屏面显示的身份"（这里）和"数据判决的身份"（middleware）可以判给两个人。
    const token = pickRequestToken(req);
    if (!token) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Not logged in.' });
    }

    try {
      const payload = auth.verifyToken(token);
      const data: any = {};
      const { avatarUrl, displayName } = req.body || {};
      if (displayName !== undefined) {
        const nextName = String(displayName).trim();
        if (!nextName) return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', message: 'Display name cannot be empty.' });
        data.displayName = nextName;
      }
      if (avatarUrl !== undefined) {
        if (avatarUrl !== null && typeof avatarUrl !== 'string') {
          return res.status(400).json({ ok: false, error: 'INVALID_AVATAR', message: 'Avatar must be an image, preset identity or null.' });
        }
        if (typeof avatarUrl === 'string') {
          if ((!AVATAR_DATA_URL_RE.test(avatarUrl) && !AVATAR_PRESET_RE.test(avatarUrl)) || avatarUrl.length > 700_000) {
            return res.status(400).json({ ok: false, error: 'INVALID_AVATAR', message: '请选择系统头像或 512KB 以内的图片。' });
          }
        }
        data.avatarUrl = avatarUrl;
      }

      const user = await options.prisma.userAccount.update({
        where: { id: payload.userId },
        data,
        include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } }, primaryDepartment: true },
      });
      const tokenPayload = await buildLoadedAuthTokenPayload(options.prisma, user);
      const { roles, permissions, departmentIds, roleIds: newRoleIds } = tokenPayload;
      await options.prisma.auditLog.create({
        data: { id: `alog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, actorId: user.id, action: 'update_profile', targetType: 'UserAccount', targetId: user.id, ip: req.ip },
      }).catch(() => undefined);
      return res.json({ ok: true, user: serializeAuthUser(user, roles, permissions, departmentIds, { newRoleIds, authorizationLoaded: tokenPayload.authorizationLoaded, permissionCeiling: payload.permissionCeiling }) });
    } catch {
      res.clearCookie(COOKIE_NAME, { path: '/' });
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Token expired or invalid.' });
    }
  });

  router.post('/refresh', async (req: Request, res: Response) => {
    const token = pickRequestToken(req);
    if (!token) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'No token to refresh.' });
    }
    try {
      const prior = auth.verifyToken(token);
      const user = await loadUserWithRoles(options.prisma, prior.userId);
      if (!user || user.status !== 'active' || user.deletedAt != null) {
        res.clearCookie(COOKIE_NAME, { path: '/' });
        return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Account disabled.' });
      }
      // Re-authentication boundary: never re-sign stale role/grant claims from
      // the old JWT, even if every current role permission has been revoked.
      const current = await buildLoadedAuthTokenPayload(options.prisma, user);
      if (prior.permissionCeiling !== undefined) current.permissionCeiling = [...prior.permissionCeiling];
      const refreshed = auth.signToken(current);
      res.cookie(COOKIE_NAME, refreshed, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: COOKIE_MAX_AGE,
        path: '/',
      });
      const payload = auth.verifyToken(refreshed);
      return res.json({ ok: true, user: payload });
    } catch {
      res.clearCookie(COOKIE_NAME, { path: '/' });
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Token expired or invalid.' });
    }
  });

  router.post('/change-password', async (req: Request, res: Response) => {
    // 取凭证走全仓唯一那份规则：显式 Bearer 优先。此处曾写作 cookie 优先（与业务路由相反），
    // 于是同一会话里"屏面显示的身份"（这里）和"数据判决的身份"（middleware）可以判给两个人。
    const token = pickRequestToken(req);
    if (!token) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Not logged in.' });
    }
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', message: 'Current and new password are required.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ ok: false, error: 'WEAK_PASSWORD', message: 'New password must be at least 6 characters.' });
    }
    try {
      const payload = auth.verifyToken(token);
      const user = await options.prisma.userAccount.findUnique({ where: { id: payload.userId } });
      if (!user || !user.passwordHash) {
        return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'User not found.' });
      }
      const valid = await auth.verifyPassword(currentPassword, user.passwordHash);
      if (!valid) {
        return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS', message: 'Current password is incorrect.' });
      }
      const newHash = await auth.hashPassword(newPassword);
      // 管理员重置密码时在 metadata 标了 forceChangePassword；本人改密后清除该标记。
      const metadata = (user.metadata && typeof user.metadata === 'object' && !Array.isArray(user.metadata)) ? user.metadata as Record<string, unknown> : null;
      await options.prisma.userAccount.update({ where: { id: payload.userId }, data: { passwordHash: newHash, ...(metadata?.forceChangePassword ? { metadata: { ...metadata, forceChangePassword: false, passwordChangedAt: new Date().toISOString() } as any } : {}) } });
      return res.json({ ok: true });
    } catch {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Token expired or invalid.' });
    }
  });

  return router;
}
