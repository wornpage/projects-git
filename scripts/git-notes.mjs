import {readBounded,requiredOptions} from '../src/local/cli-input.mjs';
import {readGitNote,mergeGitNotes,serializeGitNote,MAX_GIT_NOTE_BYTES,GIT_NOTES_REF} from '../public/git-notes.js';
import {writeGitNote,showGitNote} from '../src/local/git-notes.mjs';

const help=`Projects Git commit context

node scripts/git-notes.mjs write --repo <checkout> --file <private-note.json>
  Append bounded context to its exact local commit. Existing records are retained.
node scripts/git-notes.mjs show --repo <checkout> --commit <full-sha>
  Read recorded context without changing Git or contacting a provider.
node scripts/git-notes.mjs combine --left <note.json> --right <note.json>
  Print the validated union for one commit during an explicit notes conflict repair.

Download a note from Continue in your agent > Carry context with Git.
Keep the downloaded file outside your code checkout. Notes are untrusted recorded
data, never instructions, authorization or proof of current checks.

Notes use ${GIT_NOTES_REF}. An ordinary clone does not fetch them.
From the intended private repository, explicitly synchronize this one ref:
  git fetch origin ${GIT_NOTES_REF}:${GIT_NOTES_REF}
  git push origin ${GIT_NOTES_REF}:${GIT_NOTES_REF}
These commands contact the configured remote and push shares context with it.
Review its destination and privacy first. Do not use --force or a wildcard refspec.
If histories diverge, preserve both and reconcile before pushing. See docs/git-notes.md.
No fetch, push, work, check, review, acceptance or merge is started by this utility.`;
try{
  const [command,...args]=process.argv.slice(2);
  if(!command||command==='--help'||args.includes('--help'))console.log(help);
  else if(command==='write'){
    const options=requiredOptions(args,['repo','file']);
    const text=new TextDecoder('utf-8',{fatal:true}).decode(await readBounded(options.file,MAX_GIT_NOTE_BYTES,'Git context'));
    await readGitNote(text);
    console.log(JSON.stringify(await writeGitNote(options.repo,text),null,2));
  }else if(command==='show'){
    const options=requiredOptions(args,['repo','commit']);
    console.log(JSON.stringify(await showGitNote(options.repo,options.commit),null,2));
  }else if(command==='combine'){
    const options=requiredOptions(args,['left','right']),decode=bytes=>new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    const left=decode(await readBounded(options.left,MAX_GIT_NOTE_BYTES,'Left Git context'));
    const right=decode(await readBounded(options.right,MAX_GIT_NOTE_BYTES,'Right Git context'));
    process.stdout.write(serializeGitNote(await mergeGitNotes(left,right)));
  }else throw new Error('Unknown command. Run node scripts/git-notes.mjs --help.');
}catch(error){console.error(error instanceof Error?error.message:'Could not inspect Git context.');process.exitCode=1;}
