-- Reading an application's version is exempt from consent; enumerate processes to request real access.
tell application "System Events" to count application processes
return "granted"
