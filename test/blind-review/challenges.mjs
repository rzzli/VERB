// The coordinator fixed these challenges before receiving the independent probes.
// Each is a deterministic edit to the genuine fix. The original tests stay intact.
export const trials = [
  { id: 'empty', upstream: 'click', fix: 'd3e3852', source: 'src/click/core.py',
    author: ['tests/test_options.py::test_show_default_with_empty_string'],
    challenges: [
      ['label absent defaults', '(show_default and (default_value is not None))', 'show_default'],
      ['honor only explicitly enabled defaults', 'elif default_value == "":',
        'elif default_value == "" and self.show_default is True:']
    ] },
  { id: 'help', upstream: 'click', fix: '850bffe', source: 'src/click/core.py',
    author: ['tests/test_formatting.py::test_truncating_docstring_no_help'],
    challenges: [
      ['drop every help string containing a form feed', 'inspect.cleandoc(self.help).partition("\\f")[0]',
        '"" if "\\f" in self.help else inspect.cleandoc(self.help)'],
      ['drop later visible paragraphs', 'inspect.cleandoc(self.help).partition("\\f")[0]',
        'inspect.cleandoc(self.help).partition("\\f")[0].partition("\\n\\n")[0]']
    ] },
  { id: 'bracket', upstream: 'regexp', fix: 'e76291d', source: 'index.js',
    author: ['escapes \x60-\x60'],
    challenges: [
      ['hex-escape every character', 'whole module', 'hex'],
      ['escape only the first hyphen', "return string.replace(matchOperatorsRegex, '\\\\$&');",
        "let hyphenSeen = false;\n\treturn string.replace(matchOperatorsRegex, c => {\n\t\tif (c === '-' && hyphenSeen) return c;\n\t\tif (c === '-') hyphenSeen = true;\n\t\treturn '\\\\' + c;\n\t});"]
    ] },
  { id: 'unicode', upstream: 'regexp', fix: '732905d', source: 'index.js',
    author: ['escapes \x60-\x60', 'escapes \x60-\x60 in a way compatible with the Unicode flag'],
    challenges: [
      ['Unicode-escape every character', 'whole module', 'unicode'],
      ['escape only the first hyphen', '.replace(/-/g,', '.replace(/-/,']
    ] },
  { id: 'hyphen', upstream: 'regexp', fix: 'ec45c70', source: 'index.js',
    author: ['escapes \x60-\x60 in a way compatible with PCRE'],
    challenges: [
      ['hex-escape every character', 'whole module', 'hex'],
      ['escape only the first hyphen', '.replace(/-/g,', '.replace(/-/,']
    ] }
];

export function challengeSource(source, [, before, after]) {
  if (before === 'whole module') {
    const width = after === 'hex' ? 2 : 4;
    const prefix = after === 'hex' ? '\\x' : '\\u';
    return "module.exports = s => Array.from(s, c => " + JSON.stringify(prefix) +
      " + c.charCodeAt(0).toString(16).padStart(" + width + ", '0')).join('');\n";
  }
  if (source.split(before).length !== 2) throw Error('Expected a unique edit site for ' + before);
  return source.replace(before, () => after);
}
