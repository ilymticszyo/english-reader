import { h } from '../dom.ts';

export function mountAbout(root: HTMLElement): () => void {
  const link = (href: string, text: string) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
  root.append(
    h('h1', null, '关于与致谢'),
    h('section', { class: 'about' },
      h('h2', null, '这是什么'),
      h('p', null, 'English Reader 是一个只给自己用的纯静态英语分级阅读工具：B1 / B2 / C1 三个级别，点词即查中文词典，生词本和阅读进度只保存在本机浏览器里（localStorage），没有账号、没有服务器、没有任何统计上报。'),
      h('h2', null, '文章'),
      h('p', null, '当前所有文章均为 AI 生成的原创示例文本，不以任何受版权保护的文章为底稿。'),
      h('h2', null, '数据来源与许可'),
      h('ul', null,
        h('li', null, h('strong', null, 'ECDICT'), '（开源英汉词典数据库，MIT 许可证）：音标、中文释义、词形变化（exchange）、考试标签、柯林斯星级。© skywind3000，',
          link('https://github.com/skywind3000/ECDICT', 'github.com/skywind3000/ECDICT'), '。本站只使用其中被文章用到的词条子集。'),
        h('li', null, h('strong', null, 'CEFR-J Wordlist Version 1.5'), '（词的 CEFR 等级，A1–B2）：Compiled by Yukio Tono, Tokyo University of Foreign Studies. Retrieved from ',
          link('http://www.cefr-j.org/download.html', 'cefr-j.org/download.html'), '。版权归东京外国语大学 Tono 研究室（Tono Laboratory, TUFS）所有；数据由 ',
          link('https://github.com/openlanguageprofiles/olp-en-cefrj', 'Open Language Profiles'), ' 提供。CEFR-J 词表可免费用于研究和商业目的，须注明出处；其不对数据的准确性负责。'),
        h('li', null, h('strong', null, 'Octanove Vocabulary Profile C1/C2 (ver 1.0)'), '（词的 CEFR 等级，C1–C2）：Octanove Labs，依据 ',
          link('https://creativecommons.org/licenses/by-sa/4.0/', 'Creative Commons Attribution-ShareAlike 4.0 International（CC BY-SA 4.0）'),
          ' 许可使用。本站词典分片中的 C1/C2 等级字段派生自该词表，同样以 CC BY-SA 4.0 提供')),
      h('h2', null, '浏览器能力'),
      h('p', null, '发音使用浏览器自带的语音合成（Web Speech API），能否发声以及音色取决于你的系统是否安装了英文语音。音标来自 ECDICT，仅供参考。'),
      h('p', null, h('a', { href: '#/settings' }, '← 回到设置'))),
  );
  return () => {};
}
