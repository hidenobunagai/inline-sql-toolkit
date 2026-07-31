import marimo

__generated_with = "0.13.7"
app = marimo.App()


@app.cell
def _():
    query = "select 1"
    return (query,)


@app.cell
def _():
    sibling = "do not edit"
    return (sibling,)


if __name__ == "__main__":
    app.run()
