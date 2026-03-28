Seashell Desk is an AI-driven assistant service and file-keeping system. 

It is inspired by, but not limited to, Getting Things Done by David Allen.

The core conceit of Desk is that there is a _tight coupling between files and actions_.
The file system is a first-class system component, and it is expected that both the end-user
and the Desk system leverage the file system to communicate and observe status. 

For example, a typical Desk workflow is:

1. A Gmail input connector (desk/input/gmail.personal) polls for new emails.
2. Upon retrieving a new email, it writes a file to disk: (desk/input/gmail.personal/emails/{email_id}.json)
3. A service watching for new input files picks up the file and runs an agent.
4. The agent reads the list of projects in desk/projects and looks for project agents for which this email is appropriate.
5. In this example, the email is from American Express about an upcoming payment due date. The desk/projects/finance agent is an appropriate tool to handle this email. Multiple agents might handle one input.
6. The agent uses a hard filesystem link to copy the email file into projects/car-maintenance/input/{email_id}.json.
7. The project-level AGENT.md file is used as the basis for spawning a new task that is specific to that project.
8. The original input file is deleted to indicate that it has been processed. 
9. The project-level files/american-express/credit-card-0393/JOURNAL.md file is updated with a note saying that a payment email came through.
10. The project-level agent invokes the calendaring to put the payment reminder on the user's calendar if it is not already there. This is part of its AGENT.md instructions.
12. The input file is deleted because it has been handled.

Directory and file naming conventions are very significant. Directory and files can be composed in flexible ways
to produce different effects. Some directories at the top-level of the desk/ directory have special purposes.

- `files/`: A well-organized and deduplicated list of documents and data files that pertain to a topic. At the top level, files/ contains the definitive copy of every file in the system. At the top level, files are organized by type: e.g. emails/, audio/, pdfs/, etc. At lower levels, files are organized in a way that is sensible to the parent directory's purpose. Lower-level files/ directories contain hard-links into the top-level files/ representation. Try to preserve original filenames as much as possible so that the system remains human-legible.
- `input/`: Information that is *to be processed*. Movement of data into an input directory triggers an agent (debounced).
- `projects/`: Active areas of attention. Projects may be short-lived (e.g. birthday-party-2026) or long-lived (car-maintenance). 
- `AGENT.md`: An agent that can be delegated to by another agent to handle information specific to its directory. For example, desk/projects/finance/AGENT.md runs. In general, agents do not have access to directories other than those subordinate to their own AGENT.md file.

## Technical Architecture

Claude Code is the *central dispatcher* and primary agent orchestrator. Any part of the system
that does not have its own code can be triggered by Claude Code. Claude Code may move files
and maintain organization with the desk/ directory, and update the project's source code in src/.

The goal is to reduce Claude Code's direct involvement over time, incrementally handing off
responsibility to in-house code and user-defined workflows.

### Source Code

TypeScript is the language of choice and Bun is the favored runtime environment.
Other languages and systems may be employed if absolutely necessary.

### Package Management and Bundling

Favor Bun for managing packages and at runtime.

### Infrastructure

Code should run in a local environment and minimize its use of Cloud infrastructure.
When Cloud infrastructure is needed, use AWS and Terraform.