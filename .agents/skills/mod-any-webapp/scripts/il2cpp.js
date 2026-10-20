// IL2CPP reflection from memory alone, for any Unity WebGL game, with no il2cpp_* exports needed.
// Pass this file as the `code` of wasmcheat_run_script (wasmcheat_guide returns it as the "il2cpp"
// topic). What it returns depends on a line you put before it:
//   nothing:                                   the assemblies and how many classes each has;
//   const ASSEMBLY = 'AssetsAssembly.dll'; const MATCH = 'player|enemy|health';   matching class names;
//   const CLASSES = ['PlayerStatsHandler', 'Character'];   fields with offsets, sample values, objects.
// A mod copies the functions it needs (findClass, objects) and finds everything again by name on
// every load, because addresses move. Layout, metadata v24 to v31 on wasm32:
//   metadata header: 0xFAB11BAF, then the string table offset and size at words 6 and 7;
//   Il2CppClass:  {image, gc_desc, name*, namespace*, …, fields* somewhere in words 4..40};
//   FieldInfo:    {name*, type*, parent*, offset, token}, 20 bytes; type word 1 bits 16..23 = kind;
//   Il2CppObject: {klass*, monitor}, so live objects are the 8-aligned words equal to the class.
const memory = wasm()?.memory;
if (!memory) return 'no wasm instance captured in this frame';
const bytes = new Uint8Array(memory.buffer);
const words = new Uint32Array(memory.buffer);
const ints = new Int32Array(memory.buffer);
const floats = new Float32Array(memory.buffer);
const text = (p) => {
  let s = '';
  for (let i = p; bytes[i] && s.length < 120; i += 1) s += String.fromCharCode(bytes[i]);
  return s;
};

let header = -1;
for (let i = 0; i < words.length; i += 1) if (words[i] === 0xfab11baf) { header = i; break; }
if (header < 0) return 'no IL2CPP metadata in memory: not a Unity IL2CPP build, or it has not loaded yet';
const lo = header * 4 + words[header + 6];
const hi = lo + words[header + 7];
const named = (p) => p >= lo && p < hi;

/** Every class, grouped by its image (assembly). */
const images = new Map();
for (let i = 0; i + 3 < words.length; i += 1) {
  if (!named(words[i + 2]) || !named(words[i + 3])) continue;
  if (!images.has(words[i])) images.set(words[i], []);
  images.get(words[i]).push(i * 4);
}
const imageName = (image) => (image && image < bytes.length && named(words[image >> 2]) ? text(words[image >> 2]) : null);
const fullName = (klass) => { const ns = text(words[(klass >> 2) + 3]); return (ns ? `${ns}.` : '') + text(words[(klass >> 2) + 2]); };

const KINDS = { 2: 'bool', 3: 'char', 4: 'i8', 5: 'u8', 6: 'i16', 7: 'u16', 8: 'int', 9: 'uint', 10: 'long', 11: 'ulong', 12: 'float', 13: 'double', 14: 'string', 17: 'struct', 18: 'class', 21: 'generic', 29: 'array' };
function fieldsOf(klass) {
  for (let w = 4; w < 40; w += 1) {
    const p = words[(klass >> 2) + w];
    if (!p || p >= bytes.length - 20 || words[(p >> 2) + 2] !== klass || !named(words[p >> 2])) continue;
    const fields = [];
    for (let f = p; words[(f >> 2) + 2] === klass && named(words[f >> 2]); f += 20) {
      const bits = words[(words[(f >> 2) + 1] >> 2) + 1];
      fields.push({ name: text(words[f >> 2]), offset: ints[(f >> 2) + 3], kind: KINDS[(bits >> 16) & 0xff] ?? `kind${(bits >> 16) & 0xff}`, isStatic: (bits & 0x10) !== 0 });
    }
    return fields;
  }
  return [];
}
const parentOf = (klass) => {
  for (let w = 4; w < 30; w += 1) {
    const p = words[(klass >> 2) + w];
    if (p && p !== klass && p < bytes.length - 16 && named(words[(p >> 2) + 2]) && named(words[(p >> 2) + 3]) && images.has(words[p >> 2])) return fullName(p);
  }
  return null;
};
const objects = (klass, limit = 200) => {
  const found = [];
  for (let i = 0; i < words.length && found.length < limit; i += 2) if (words[i] === klass && words[i + 1] === 0) found.push(i * 4);
  return found;
};
const valueAt = (object, field) => {
  const at = object + field.offset;
  if (field.kind === 'float') return +floats[at >> 2].toFixed(3);
  if (field.kind === 'bool' || field.kind === 'u8') return bytes[at];
  if (field.kind === 'int') return ints[at >> 2];
  return undefined;
};

if (typeof CLASSES !== 'undefined') {
  const wanted = new Set(CLASSES);
  const out = {};
  for (const [image, classes] of images) {
    for (const klass of classes) {
      const name = fullName(klass);
      if (!wanted.has(name) || out[name]) continue;
      const fields = fieldsOf(klass);
      const live = objects(klass);
      if (fields.length === 0) {
        out[name] = { klass: `0x${klass.toString(16)}`, assembly: imageName(image), objects: live.length, fields: 'not filled in yet: IL2CPP does it the first time the game uses the class, so play until it has' };
        continue;
      }
      out[name] = {
        klass: `0x${klass.toString(16)}`,
        assembly: imageName(image),
        parent: parentOf(klass),
        objects: live.length,
        // Old objects linger until the GC reuses them: several samples show which ones are live.
        fields: fields.map((field) => `${field.isStatic ? 'static ' : ''}${field.kind} ${field.name} @${field.offset}` +
          (field.isStatic ? '' : ` = ${live.slice(0, 4).map((object) => valueAt(object, field)).filter((v) => v !== undefined).join(' | ')}`)),
      };
    }
  }
  return out;
}
if (typeof ASSEMBLY !== 'undefined') {
  const match = new RegExp(typeof MATCH === 'undefined' ? '.' : MATCH, 'i');
  const [, classes] = [...images].find(([image]) => imageName(image) === ASSEMBLY) ?? [null, []];
  return [...new Set(classes.map(fullName))].filter((name) => match.test(name) && !name.includes('<')).sort().join(' ');
}
const assemblies = {};
for (const [image, classes] of images) { const name = imageName(image); if (name && classes.length >= 20) assemblies[name] = classes.length; }
return { metadataVersion: words[header + 1], assemblies, hint: 'the game is usually Assembly-CSharp.dll or the biggest non-Unity, non-System assembly' };
