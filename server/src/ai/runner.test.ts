import { describe, expect, it, vi } from 'vitest';
import { buildAttachmentContextFromAttachments } from './runner';

const blankPdfBase64 = 'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMjAwXSAvUmVzb3VyY2VzIDw8ID4+IC9Db250ZW50cyA0IDAgUiA+PgplbmRvYmoKNCAwIG9iago8PCAvTGVuZ3RoIDAgPj4Kc3RyZWFtCgplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA1CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDIxOSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDUgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjI2OAolJUVPRgo=';

describe('Mac mini AI runner context', () => {
  it('turns workspace text files into model context', async () => {
    const context = await buildAttachmentContextFromAttachments([{
      name: '产品标准要求.txt',
      mimeType: 'text/plain',
      data: Buffer.from('面料克重要求 260G/M，必须通过 RWS 认证。').toString('base64'),
    }]);

    expect(context).toHaveLength(1);
    expect(context[0]).toMatchObject({
      title: '产品标准要求.txt',
      category: 'WorkspaceFile',
      source: 'workspace-attachment/file',
      scopes: ['company'],
    });
    expect(context[0].content).toContain('面料克重要求 260G/M');
  });

  it('does not pretend image workspace files have been visually read', async () => {
    const context = await buildAttachmentContextFromAttachments([{
      name: '面料照片.png',
      mimeType: 'image/png',
      data: 'iVBORw0KGgo=',
    }]);

    expect(context).toHaveLength(1);
    expect(context[0].source).toBe('workspace-attachment/image');
    expect(context[0].content).toContain('视觉模型未配置');
  });

  it('uses the configured vision model for image workspace files', async () => {
    const previousModel = process.env.BAMBOOK_VISION_MODEL_NAME;
    const previousBase = process.env.BAMBOOK_VISION_BASE_URL;
    const previousKey = process.env.BAMBOOK_VISION_API_KEY;
    process.env.BAMBOOK_VISION_MODEL_NAME = 'doubao-vision-test';
    process.env.BAMBOOK_VISION_BASE_URL = 'https://vision.test/api/v3';
    process.env.BAMBOOK_VISION_API_KEY = 'vision-key';
    const fetchSpy = vi.fn(async (url: URL | string, init?: any) => {
      const body = JSON.parse(String(init.body));
      expect(String(url)).toBe('https://vision.test/api/v3/chat/completions');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer vision-key');
      expect(body.model).toBe('doubao-vision-test');
      expect(body.messages[1].content[1].image_url.url).toBe('data:image/png;base64,iVBORw0KGgo=');
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '识别结果：蓝色斜纹面料，克重约 260G/M。' } }] }),
      } as any;
    });
    vi.stubGlobal('fetch', fetchSpy);

    try {
      const context = await buildAttachmentContextFromAttachments([{
        name: '面料照片.png',
        mimeType: 'image/png',
        data: 'iVBORw0KGgo=',
      }]);

      expect(context).toHaveLength(1);
      expect(context[0].source).toBe('workspace-attachment/vision');
      expect(context[0].content).toContain('视觉模型: doubao-vision-test');
      expect(context[0].content).toContain('蓝色斜纹面料');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      if (previousModel === undefined) delete process.env.BAMBOOK_VISION_MODEL_NAME;
      else process.env.BAMBOOK_VISION_MODEL_NAME = previousModel;
      if (previousBase === undefined) delete process.env.BAMBOOK_VISION_BASE_URL;
      else process.env.BAMBOOK_VISION_BASE_URL = previousBase;
      if (previousKey === undefined) delete process.env.BAMBOOK_VISION_API_KEY;
      else process.env.BAMBOOK_VISION_API_KEY = previousKey;
      vi.unstubAllGlobals();
    }
  });

  it('does not treat page markers as readable PDF text without a vision model', async () => {
    const previousModel = process.env.BAMBOOK_VISION_MODEL_NAME;
    const previousKey = process.env.BAMBOOK_VISION_API_KEY;
    delete process.env.BAMBOOK_VISION_MODEL_NAME;
    delete process.env.BAMBOOK_VISION_API_KEY;

    try {
      const context = await buildAttachmentContextFromAttachments([{
        name: '扫描标准.pdf',
        mimeType: 'application/pdf',
        data: blankPdfBase64,
      }]);

      expect(context).toHaveLength(1);
      expect(context[0].source).toBe('workspace-attachment/pdf');
      expect(context[0].content).toContain('PDF 未提取到可读文本');
      expect(context[0].content).toContain('视觉模型未配置');
      expect(context[0].content).not.toContain('-- 1 of 1 --');
    } finally {
      if (previousModel === undefined) delete process.env.BAMBOOK_VISION_MODEL_NAME;
      else process.env.BAMBOOK_VISION_MODEL_NAME = previousModel;
      if (previousKey === undefined) delete process.env.BAMBOOK_VISION_API_KEY;
      else process.env.BAMBOOK_VISION_API_KEY = previousKey;
    }
  });

  it('renders image-only PDF pages through the configured vision model', async () => {
    const previousModel = process.env.BAMBOOK_VISION_MODEL_NAME;
    const previousBase = process.env.BAMBOOK_VISION_BASE_URL;
    const previousKey = process.env.BAMBOOK_VISION_API_KEY;
    process.env.BAMBOOK_VISION_MODEL_NAME = 'doubao-vision-test';
    process.env.BAMBOOK_VISION_BASE_URL = 'https://vision.test/api/v3';
    process.env.BAMBOOK_VISION_API_KEY = 'vision-key';
    const fetchSpy = vi.fn(async (url: URL | string, init?: any) => {
      const body = JSON.parse(String(init.body));
      expect(String(url)).toBe('https://vision.test/api/v3/chat/completions');
      expect(body.model).toBe('doubao-vision-test');
      expect(body.messages[1].content[0].text).toContain('扫描标准.pdf 第 1 页');
      expect(body.messages[1].content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '第 1 页识别：产品标准要求为 260G/M。' } }] }),
      } as any;
    });
    vi.stubGlobal('fetch', fetchSpy);

    try {
      const context = await buildAttachmentContextFromAttachments([{
        name: '扫描标准.pdf',
        mimeType: 'application/pdf',
        data: blankPdfBase64,
      }]);

      expect(context).toHaveLength(1);
      expect(context[0].source).toBe('workspace-attachment/pdf-vision');
      expect(context[0].content).toContain('PDF 文本层为空');
      expect(context[0].content).toContain('产品标准要求为 260G/M');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      if (previousModel === undefined) delete process.env.BAMBOOK_VISION_MODEL_NAME;
      else process.env.BAMBOOK_VISION_MODEL_NAME = previousModel;
      if (previousBase === undefined) delete process.env.BAMBOOK_VISION_BASE_URL;
      else process.env.BAMBOOK_VISION_BASE_URL = previousBase;
      if (previousKey === undefined) delete process.env.BAMBOOK_VISION_API_KEY;
      else process.env.BAMBOOK_VISION_API_KEY = previousKey;
      vi.unstubAllGlobals();
    }
  });
});
