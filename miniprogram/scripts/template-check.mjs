// WXML expressions are not HTML: XML entity text inside {{ }} can pass a local
// package compile and still fail WeChat's upload-side template validation
export function checkTemplate(text, name) {
  for (const expression of text.matchAll(/{{[\s\S]*?}}/g)) {
    if (/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/i.test(expression[0])) {
      throw new Error("WXML expression contains HTML entities: " + name);
    }
  }
}
