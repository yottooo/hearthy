# Example documents

These files describe things that don't exist (a kettle and a company), so the model cannot know the
answers from its training data. If `hearthy ask` gets them right and cites these files, retrieval is
doing its job.

Try:

```bash
hearthy ingest ./examples/docs
hearthy ask "What does error E4 mean on the kettle?"
hearthy ask "How many days of remote work does Emberlight allow?"
hearthy ask "Who do I page if production is down at night?"
```
