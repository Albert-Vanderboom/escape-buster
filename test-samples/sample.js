// Sample JavaScript file with escaped strings
const simpleString = "This is a simple string with no escape sequences";
const stringWithNewlines = "This string has\nnewlines\nin it";
const stringWithTabs = "This string has\ttabs\tin it";
const mixedEscapes = "This string has both\nnewlines and\ttabs";

const codeExample = "function helloWorld() {\n\tconsole.log(\"Hello, world!\");\n\treturn true;\n}";

const jsonData = `{
  "name": "John Doe",
  "age": 30,
  "isActive": true,
  "address": {
    "street": "123 Main St",
    "city": "Anytown"
  }
}`;

function processString(input) {
    console.log("Processing string:", input);
    return input.replace(/\\n/g, '\n')
                .replace(/\\t/g, '\t')
                .replace(/\\r/g, '\r');
}

// Export some test values
module.exports = {
    simpleString,
    stringWithNewlines,
    stringWithTabs,
    mixedEscapes,
    codeExample,
    htmlExample,
    jsonData,
    processString
}; 